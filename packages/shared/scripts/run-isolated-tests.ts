import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { basename, join, relative } from "node:path";

import { Glob } from "bun";

export interface IsolatedTestOptions {
  /** Test files outside the collected globs that should always run. */
  extraFiles?: string[];
  /**
   * Drops a collected file from the run (assistant uses this for benchmark,
   * known-broken, and experimental-only files).
   */
  filter?: (file: string) => boolean;
  /** Extra arguments passed through to every `bun test` invocation. */
  bunTestArgs?: string[];
  /** Runs once before collection (assistant: bundled catalog sync). */
  setup?: () => void;
  /**
   * Builds a test fixture once up front in a subprocess (assistant: the
   * pre-migrated DB). The fixture root is exported as `envVar` and the build
   * subprocess receives the fixture's "migrated" directory as its argument.
   */
  fixture?: { script: string; envVar: string };
}

// Run only test files changed vs main; fails open when the diff cannot be
// computed — a stale or absent base must never green-light a PR.
const TEST_DIFF_ONLY = process.env.TEST_DIFF_ONLY === "true";
const TEST_DIFF_BASE = "origin/main";
// One pattern set for every consumer: globs that match nothing in a given
// package are simply empty, so the union stays harmless everywhere.
const PATTERNS = [
  "src/**/*.test.{ts,tsx}",
  "scripts/**/*.test.{ts,js}",
  ".storybook/**/*.test.{ts,tsx}",
  "eslint-rules/**/*.test.mjs",
];
// Shallow depth for fetching refs the diff needs. Pull-request checkouts run
// at a limited depth, so `origin/main` is often absent; this is deep enough
// for any realistic merge-base while staying ~10x cheaper than a full clone.
const DIFF_FETCH_DEPTH = "200";
// Wall-clock kill per test file: bun processes that pass but don't exit (open
// handles) would otherwise wedge a worker until the job timeout. SIGTERM
// first, then SIGKILL after a grace period, mirroring `timeout -k 10`.
const PER_TEST_TIMEOUT_MS =
  (Number.parseInt(process.env.PER_TEST_TIMEOUT ?? "", 10) || 120) * 1000;
const KILL_GRACE_MS = 10_000;

export async function runIsolatedTests({
  extraFiles = [],
  filter,
  bunTestArgs = [],
  setup,
  fixture,
}: IsolatedTestOptions = {}): Promise<void> {
  const cwd = process.cwd();
  setup?.();

  // Timing-sensitive suites (real timers, `waitFor` deadlines) fail once the
  // cores are saturated, so the default leaves half of them free.
  const defaultConcurrency = Math.min(
    8,
    Math.max(2, Math.floor(availableParallelism() / 2)),
  );
  const concurrency = Math.max(
    1,
    Number.parseInt(
      process.env.TEST_CONCURRENCY ?? process.env.TEST_WORKERS ?? "",
      10,
    ) || defaultConcurrency,
  );
  const shard = parseShard(process.env.TEST_SHARD);
  // Bun's default per-test timeout is 5s. Under saturated CI cores, RTL
  // `waitFor` loops and slow integration tests can stretch past that even
  // though they settle locally. TEST_TIMEOUT_MS / BUN_TEST_TIMEOUT lift the
  // ceiling; 30s still fails a genuine hang, just after a slower one.
  const timeoutMs =
    Number.parseInt(process.env.TEST_TIMEOUT_MS ?? "", 10) ||
    Number.parseInt(process.env.BUN_TEST_TIMEOUT ?? "", 10) ||
    30000;

  const allFiles = [
    // `dot` is off by default, and the walker skips dot-directories even
    // when a pattern spells one out, so suites under `.storybook/` need
    // it on to be found at all.
    // https://bun.sh/docs/api/glob#scan
    ...PATTERNS.flatMap((pattern) => [
      ...new Glob(pattern).scanSync({ cwd, dot: true }),
    ]),
    ...extraFiles,
  ]
    .sort()
    .filter((file) => filter?.(file) ?? true);
  if (allFiles.length === 0) {
    console.error("No test files found");
    process.exit(1);
  }

  const diffed = TEST_DIFF_ONLY ? diffTestFiles(allFiles, cwd) : null;
  const scoped = diffed ?? allFiles;
  if (diffed && scoped.length === 0) {
    console.log(
      `No test files changed vs ${TEST_DIFF_BASE} — nothing to run.`,
    );
    return;
  }
  // Longest-first ordering (when a durations file exists) before sharding, so
  // round-robin shards split the slow files evenly.
  const sorted = sortLongestFirst(scoped);
  const files = shard
    ? sorted.filter((_, index) => index % shard.total === shard.index - 1)
    : sorted;
  if (files.length === 0) {
    console.log(`Nothing to run in shard ${shard?.index}/${shard?.total}`);
    return;
  }

  // Build the fixture once, up front, in a dedicated subprocess. Each test
  // process inherits the fixtures root through the exported env var.
  const fixturesRoot = mkdtempSync(join(tmpdir(), "cadet-test-fixtures-"));
  if (fixture) {
    const fixtureDir = join(fixturesRoot, "migrated");
    const proc = Bun.spawn(["bun", "run", fixture.script, fixtureDir], {
      cwd,
      stdout: "inherit",
      stderr: "inherit",
    });
    const code = await proc.exited;
    if (code !== 0) {
      console.error(`Failed to build test fixture (exit ${code})`);
      process.exit(1);
    }
    process.env[fixture.envVar] = fixturesRoot;
  }

  console.log(
    `Running ${files.length} test file(s) (${concurrency} workers)${
      shard ? `, shard ${shard.index}/${shard.total}` : ""
    }`,
  );

  const resultsDir = mkdtempSync(join(tmpdir(), "cadet-test-run-"));
  const coverage = process.env.COVERAGE === "true";
  let coverageBase = "";
  if (coverage) {
    coverageBase = join(cwd, "coverage");
    rmSync(coverageBase, { recursive: true, force: true });
    mkdirSync(coverageBase, { recursive: true });
  }

  const results: FileResult[] = [];

  // A rolling pool keeps every slot busy, so a slow file occupies only its
  // own slot while the others keep pulling work.
  let next = 0;
  async function worker(): Promise<void> {
    while (next < files.length) {
      const file = files[next++];
      results.push(
        await runOneFile(file, { cwd, timeoutMs, bunTestArgs, resultsDir, coverage }),
      );
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, files.length) }, worker),
  );

  // Record durations for longest-first scheduling in future runs. Written
  // before the failure exit so durations persist even when tests fail.
  const durationsOutput = process.env.TEST_DURATIONS_OUTPUT ?? "";
  if (durationsOutput) {
    const sortedResults = [...results].sort((a, b) => b.elapsedMs - a.elapsedMs);
    writeFileSync(
      durationsOutput,
      sortedResults.map((r) => `${r.elapsedMs}\t${r.file}`).join("\n") + "\n",
    );
    console.log(`Wrote test durations to ${durationsOutput}`);
  }

  const failures = results.filter((r) => r.outcome === "fail");
  if (failures.length > 0) {
    console.log("");
    for (const result of failures) {
      console.log("──────────────────────────────────────────");
      console.log(`FAIL: ${result.file}`);
      console.log("──────────────────────────────────────────");
      process.stdout.write(result.output);
      console.log("");
    }
    console.log("========================================");
    console.log(`  FAILED TEST FILES (${failures.length}):`);
    console.log("========================================");
    for (const result of failures) {
      console.log(`  ✗ ${result.file}`);
    }
    console.log("========================================");
    rmSync(resultsDir, { recursive: true, force: true });
    rmSync(fixturesRoot, { recursive: true, force: true });
    process.exit(1);
  }

  if (coverage) {
    const mergedPath = join(coverageBase, "lcov.info");
    if (mergeLcov(resultsDir, mergedPath)) {
      console.log("Coverage report written to coverage/lcov.info");
    } else {
      console.log("Warning: no coverage data was generated");
    }
  }

  rmSync(resultsDir, { recursive: true, force: true });
  rmSync(fixturesRoot, { recursive: true, force: true });

  const passed = results.filter((r) => r.outcome !== "fail").length;
  console.log(
    `\n${passed} passed, ${failures.length} failed (${files.length} test files${
      shard ? `, shard ${shard.index}/${shard.total}` : ""
    })`,
  );
}

// ---------------------------------------------------------------------------
// Running a single test file
// ---------------------------------------------------------------------------

interface RunResult {
  exitCode: number;
  output: string;
  timedOut: boolean;
}

const hasFailedAssertion = (out: string): boolean => /^\(fail\)/m.test(out);
const reachedEndOfRun = (out: string): boolean =>
  /^Ran \d+ tests? across/m.test(out);

async function runBunTest(
  file: string,
  opts: {
    cwd: string;
    timeoutMs: number;
    bunTestArgs: string[];
    coverageArgs: string[];
  },
): Promise<RunResult> {
  // `bun test` reads a bare argument as a filename filter, and a filter never
  // matches a path under a dot-directory, so every file is passed as an
  // explicit relative path.
  // https://bun.sh/docs/cli/test#run-specific-tests
  const path =
    file.startsWith("./") || file.startsWith("/") ? file : `./${file}`;
  const args = [
    "test",
    ...opts.coverageArgs,
    ...opts.bunTestArgs,
    `--timeout=${opts.timeoutMs}`,
    path,
  ];
  const proc = Bun.spawn(["bun", ...args], {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  killTimer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGTERM");
    graceTimer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already exited */
      }
    }, KILL_GRACE_MS);
  }, PER_TEST_TIMEOUT_MS);

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (killTimer) {
    clearTimeout(killTimer);
  }
  if (graceTimer) {
    clearTimeout(graceTimer);
  }

  return { exitCode, output: stdout + stderr, timedOut };
}

type Outcome = "pass" | "fail" | "hung-pass";

interface FileResult {
  file: string;
  outcome: Outcome;
  elapsedMs: number;
  output: string;
}

interface RunOneFileOpts {
  cwd: string;
  timeoutMs: number;
  bunTestArgs: string[];
  resultsDir: string;
  coverage: boolean;
}

async function runOneFile(
  file: string,
  opts: RunOneFileOpts,
): Promise<FileResult> {
  const base = basename(file);
  const coverageArgs: string[] = [];
  if (opts.coverage) {
    const safe = file.replace(/\//g, "_");
    const covDir = join(opts.resultsDir, `cov_${safe}`);
    mkdirSync(covDir, { recursive: true });
    coverageArgs.push(
      "--coverage",
      "--coverage-reporter=lcov",
      `--coverage-dir=${covDir}`,
    );
  }

  const start = performance.now();
  let { exitCode, output, timedOut } = await runBunTest(file, {
    ...opts,
    coverageArgs,
  });

  // Retry once when a failing run produced no conclusive test evidence:
  //   - transient loader/runtime crash (non-zero, non-timeout exit)
  //   - transient hang (timeout kill before the end-of-run summary)
  // Neither leaves a "(fail)" line; genuine assertion failures print one and
  // are reported immediately (fast feedback, no masking of intermittent
  // failures). A timed-out run that reached the end-of-run summary is the
  // passed-but-hung-at-exit case — no retry needed.
  let retryReason = "";
  if (exitCode !== 0 && !hasFailedAssertion(output)) {
    if (timedOut) {
      if (!reachedEndOfRun(output)) {
        retryReason = "hung without completing";
      }
    } else {
      retryReason = `transient crash, exit ${exitCode}`;
    }
  }
  if (retryReason) {
    console.log(`  ↻ ${base} (${retryReason} — retrying once)`);
    ({ exitCode, output, timedOut } = await runBunTest(file, {
      ...opts,
      coverageArgs,
    }));
  }

  const elapsedMs = Math.round(performance.now() - start);

  let outcome: Outcome;
  let line: string;
  if (timedOut) {
    // The process was killed by the timeout. It passed only if there were no
    // failures AND the end-of-run summary is present; without the summary it
    // was killed mid-run.
    if (hasFailedAssertion(output)) {
      outcome = "fail";
      line = `  ✗ ${base} (killed after wall-clock timeout — tests failed and process hung)`;
    } else if (reachedEndOfRun(output)) {
      outcome = "hung-pass";
      line = `  ⚠ ${base} (tests passed but process hung — likely open handles)`;
    } else {
      outcome = "fail";
      line = `  ✗ ${base} (killed after wall-clock timeout — test run did not complete)`;
    }
  } else if (exitCode !== 0) {
    outcome = "fail";
    line = `  ✗ ${base} (${elapsedMs}ms)`;
  } else {
    outcome = "pass";
    line = `  ✓ ${base} (${elapsedMs}ms)`;
  }
  console.log(line);

  return { file, outcome, elapsedMs, output };
}

// ---------------------------------------------------------------------------
// Collection helpers
// ---------------------------------------------------------------------------

/**
 * Sorts tests longest-first using durations from a previous run, so slow
 * tests start immediately across all workers instead of piling up at the end
 * and becoming long poles. No-op without TEST_DURATIONS_FILE.
 */
function sortLongestFirst(files: string[]): string[] {
  const durationsFile = process.env.TEST_DURATIONS_FILE ?? "";
  if (!durationsFile || !existsSync(durationsFile)) {
    return files;
  }
  const durMap = new Map<string, number>();
  for (const line of readFileSync(durationsFile, "utf-8").split("\n")) {
    if (!line) {
      continue;
    }
    const tab = line.indexOf("\t");
    if (tab === -1) {
      continue;
    }
    const ms = Number.parseInt(line.slice(0, tab), 10);
    const path = line.slice(tab + 1);
    if (path) {
      durMap.set(path, ms);
    }
  }
  const known: string[] = [];
  const unknown: string[] = [];
  for (const f of files) {
    (durMap.has(f) ? known : unknown).push(f);
  }
  known.sort((a, b) => (durMap.get(b) ?? 0) - (durMap.get(a) ?? 0));
  console.log(
    `Sorted tests longest-first using ${durationsFile} (${known.length} known, ${unknown.length} new)`,
  );
  return [...known, ...unknown];
}

/**
 * Intersects the collected test files with those changed vs main under the
 * calling package's own directory (derived from its cwd). Returns null when
 * the diff cannot be computed (missing base ref, shallow clone), which callers
 * treat as "run everything" — a stale or absent base must never green-light a
 * PR.
 */
function diffTestFiles(files: string[], cwd: string): string[] | null {
  // Three levels up from packages/shared/scripts.
  const repoRoot = join(import.meta.dir, "..", "..", "..");
  ensureBaseRef(repoRoot);
  const pkgDir = relative(repoRoot, cwd);
  const proc = Bun.spawnSync(
    ["git", "diff", "--name-only", `${TEST_DIFF_BASE}...HEAD`, "--", pkgDir],
    { cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
  );
  if (proc.exitCode !== 0) {
    console.log(
      `Could not diff vs ${TEST_DIFF_BASE} (exit ${proc.exitCode}: ${proc.stderr.toString().trim()}) — running the full suite.`,
    );
    return null;
  }
  const prefix = pkgDir === "" ? "" : `${pkgDir}/`;
  const changed = new Set(
    proc.stdout
      .toString()
      .split("\n")
      .filter(Boolean)
      .filter((p) => p.startsWith(prefix))
      .map((p) => p.slice(prefix.length)),
  );
  const scoped = files.filter((f) => changed.has(f));
  console.log(
    `Diff vs ${TEST_DIFF_BASE} touched ${changed.size} file(s); ${scoped.length} of ${files.length} collected test files match.`,
  );
  return scoped;
}

/**
 * PR checkouts run at a limited fetch depth, so `origin/main` is usually
 * absent. Fetch it shallowly (best effort) so the diff can compute; when this
 * fails the diff falls open to the full suite.
 */
function ensureBaseRef(repoRoot: string): void {
  const check = Bun.spawnSync(
    ["git", "rev-parse", "--verify", "--quiet", TEST_DIFF_BASE],
    { cwd: repoRoot, stdout: "ignore", stderr: "ignore" },
  );
  if (check.exitCode === 0) {
    return;
  }
  console.log(
    `${TEST_DIFF_BASE} not fetched — fetching it at depth ${DIFF_FETCH_DEPTH}...`,
  );
  Bun.spawnSync(
    [
      "git",
      "fetch",
      "--no-tags",
      `--depth=${DIFF_FETCH_DEPTH}`,
      "origin",
      "main",
    ],
    { cwd: repoRoot, stdout: "ignore", stderr: "ignore" },
  );
}

/**
 * Parses `TEST_SHARD=<index>/<total>` (1-based), which splits the sorted file
 * list round-robin so CI can fan one suite out across parallel jobs.
 */
function parseShard(
  value: string | undefined,
): { index: number; total: number } | undefined {
  if (!value) {
    return undefined;
  }
  const match = /^(\d+)\/(\d+)$/.exec(value);
  const index = match ? Number(match[1]) : 0;
  const total = match ? Number(match[2]) : 0;
  if (index < 1 || index > total) {
    throw new Error(`TEST_SHARD must look like "1/4", got "${value}"`);
  }
  return { index, total };
}

// ---------------------------------------------------------------------------
// Coverage merge
//
// Merges per-file lcov reports, deduplicating source files that appear in
// multiple runs — raw concatenation would count shared files multiple times.
// DA/FNDA/BRDA execution counts are summed; FN/DA/BRDA identities keep their
// first-seen order.
// ---------------------------------------------------------------------------

function mergeLcov(rawLcovDir: string, mergedPath: string): boolean {
  interface FileCov {
    daOrder: string[]; // line numbers in first-seen order
    da: Map<string, number>; // line -> summed count
    fnOrder: string[]; // "line,name" in first-seen order
    fnSeen: Set<string>;
    fndaOrder: string[]; // "line,name" in first-seen order
    fnda: Map<string, number>; // "line,name" -> summed count
    brdaOrder: string[]; // "line,block,branch" in first-seen order
    brda: Map<string, number>; // key -> summed taken
    brdaNumeric: Set<string>; // keys that had a numeric taken
  }
  const filesMap = new Map<string, FileCov>();
  const fileOrder: string[] = [];

  const emptyCov = (): FileCov => ({
    daOrder: [],
    da: new Map(),
    fnOrder: [],
    fnSeen: new Set(),
    fndaOrder: [],
    fnda: new Map(),
    brdaOrder: [],
    brda: new Map(),
    brdaNumeric: new Set(),
  });

  // Concatenate all per-file lcov files, then walk line by line.
  const covDirs = readdirSync(rawLcovDir).filter((d) => d.startsWith("cov_"));
  let sawAny = false;
  for (const dir of covDirs) {
    const lcovFile = join(rawLcovDir, dir, "lcov.info");
    if (!existsSync(lcovFile)) {
      continue;
    }
    sawAny = true;
    let cur: FileCov | null = null;
    // FN/FNDA are paired by position WITHIN a file's SF block.
    let blockFnAt: string[] = [];
    let blockFndaIdx = 0;
    for (const raw of readFileSync(lcovFile, "utf-8").split("\n")) {
      if (raw.startsWith("SF:")) {
        const sf = raw.slice(3);
        if (!filesMap.has(sf)) {
          filesMap.set(sf, emptyCov());
          fileOrder.push(sf);
        }
        cur = filesMap.get(sf)!;
        blockFnAt = [];
        blockFndaIdx = 0;
      } else if (raw.startsWith("DA:") && cur) {
        const [line, countStr] = raw.slice(3).split(",");
        const count = Number.parseInt(countStr, 10) || 0;
        if (cur.da.has(line)) {
          cur.da.set(line, cur.da.get(line)! + count);
        } else {
          cur.da.set(line, count);
          cur.daOrder.push(line);
        }
      } else if (raw.startsWith("FN:") && cur) {
        const entry = raw.slice(3); // "line,name"
        if (!cur.fnSeen.has(entry)) {
          cur.fnSeen.add(entry);
          cur.fnOrder.push(entry);
        }
        blockFnAt.push(entry);
      } else if (raw.startsWith("FNDA:") && cur) {
        const rest = raw.slice(5); // "count,name"
        const count = Number.parseInt(rest.split(",")[0], 10) || 0;
        // Pair with the FN at the same position within this block.
        const fnFull =
          blockFnAt[blockFndaIdx] ?? rest.slice(rest.indexOf(",") + 1);
        blockFndaIdx++;
        if (cur.fnda.has(fnFull)) {
          cur.fnda.set(fnFull, cur.fnda.get(fnFull)! + count);
        } else {
          cur.fnda.set(fnFull, count);
          cur.fndaOrder.push(fnFull);
        }
      } else if (raw.startsWith("BRDA:") && cur) {
        const parts = raw.slice(5).split(",");
        const key = `${parts[0]},${parts[1]},${parts[2]}`;
        const taken = parts[3];
        if (taken === "-") {
          if (!cur.brdaNumeric.has(key) && !cur.brda.has(key)) {
            cur.brda.set(key, 0);
          }
        } else {
          const takenCount = Number.parseInt(taken, 10) || 0;
          if (cur.brdaNumeric.has(key)) {
            cur.brda.set(key, cur.brda.get(key)! + takenCount);
          } else {
            cur.brda.set(key, takenCount);
          }
          cur.brdaNumeric.add(key);
        }
        if (!cur.brdaOrder.includes(key)) {
          cur.brdaOrder.push(key);
        }
      }
    }
  }

  if (!sawAny) {
    return false;
  }

  const out: string[] = [];
  for (const sf of fileOrder) {
    const cov = filesMap.get(sf)!;
    out.push(`SF:${sf}`);
    for (const fn of cov.fnOrder) {
      out.push(`FN:${fn}`);
    }
    let fnf = 0;
    let fnh = 0;
    for (const entry of cov.fndaOrder) {
      const count = cov.fnda.get(entry)!;
      // entry is "line,name" — strip leading "line," to get the name.
      const comma = entry.indexOf(",");
      const name = comma === -1 ? entry : entry.slice(comma + 1);
      out.push(`FNDA:${count},${name}`);
      fnf++;
      if (count > 0) {
        fnh++;
      }
    }
    out.push(`FNF:${fnf}`);
    out.push(`FNH:${fnh}`);
    let brf = 0;
    let brh = 0;
    const brLines: string[] = [];
    for (const key of cov.brdaOrder) {
      if (cov.brdaNumeric.has(key)) {
        const taken = cov.brda.get(key)!;
        brLines.push(`BRDA:${key},${taken}`);
        brf++;
        if (taken > 0) {
          brh++;
        }
      } else {
        brLines.push(`BRDA:${key},-`);
        brf++;
      }
    }
    out.push(...brLines);
    if (brf > 0) {
      out.push(`BRF:${brf}`);
      out.push(`BRH:${brh}`);
    }
    let lf = 0;
    let lh = 0;
    for (const line of cov.daOrder) {
      const count = cov.da.get(line)!;
      out.push(`DA:${line},${count}`);
      lf++;
      if (count > 0) {
        lh++;
      }
    }
    out.push(`LF:${lf}`);
    out.push(`LH:${lh}`);
    out.push("end_of_record");
  }
  writeFileSync(mergedPath, out.join("\n") + "\n");
  return true;
}
