import { availableParallelism } from "node:os";
import { join, relative } from "node:path";

import { Glob } from "bun";

export interface IsolatedTestOptions {
  extraFiles?: string[];
}

// Run only test files changed vs main; fails open when the diff cannot be
// computed. Same contract as gateway/scripts/test.ts.
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

export async function runIsolatedTests({
  extraFiles = [],
}: IsolatedTestOptions = {}): Promise<void> {
  const cwd = process.cwd();
  const args = process.argv.slice(2);
  // Timing-sensitive suites (real timers, `waitFor` deadlines) fail once the
  // cores are saturated, so the default leaves half of them free.
  const defaultConcurrency = Math.min(
    8,
    Math.max(2, Math.floor(availableParallelism() / 2)),
  );
  const concurrency = Math.max(
    1,
    Number.parseInt(process.env.TEST_CONCURRENCY ?? "", 10) ||
      defaultConcurrency,
  );
  const shard = parseShard(process.env.TEST_SHARD);
  const allFiles =
    args.length > 0
      ? args
      : [
          // `dot` is off by default, and the walker skips dot-directories even
          // when a pattern spells one out, so suites under `.storybook/` need
          // it on to be found at all.
          // https://bun.sh/docs/api/glob#scan
          ...PATTERNS.flatMap((pattern) => [
            ...new Glob(pattern).scanSync({ cwd, dot: true }),
          ]),
          ...extraFiles,
        ].sort();
  const diffed = TEST_DIFF_ONLY ? diffTestFiles(allFiles, cwd) : null;
  const scoped = diffed ?? allFiles;
  const files = shard
    ? scoped.filter((_, index) => index % shard.total === shard.index - 1)
    : scoped;

  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  async function runFile(file: string): Promise<boolean> {
    // `bun test` reads a bare argument as a filename filter, and a filter never
    // matches a path under a dot-directory, so every file is passed as an
    // explicit relative path.
    // https://bun.sh/docs/cli/test#run-specific-tests
    const path =
      file.startsWith("./") || file.startsWith("/") ? file : `./${file}`;
    // Bun's default per-test timeout is 5s. Under saturated CI cores, the
    // RTL `waitFor` loop alone (act-wrapped polling) can stretch past that on
    // heavy component suites even though the asserted condition settles in
    // tens of milliseconds, which reads as a hang rather than slowness.
    // `TEST_TIMEOUT_MS` lifts the ceiling for exactly this; 15s still fails
    // a genuine hang, just after a slower one.
    const timeoutMs = Number.parseInt(process.env.TEST_TIMEOUT_MS ?? "", 10);
    const timeoutArgs =
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? ["--timeout", String(timeoutMs)]
        : [];
    const proc = Bun.spawn(["bun", "test", ...timeoutArgs, path], {
      stdout: "pipe",
      stderr: "pipe",
      cwd,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      process.stderr.write(`\nFailed: ${file}\n${stdout}${stderr}`);
      return false;
    }
    return true;
  }

  // A rolling pool keeps every slot busy, so a slow file occupies only its own
  // slot while the others keep pulling work.
  let next = 0;
  async function worker(): Promise<void> {
    while (next < files.length) {
      const file = files[next++];
      if (await runFile(file)) {
        passed++;
      } else {
        failed++;
        failures.push(file);
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, files.length) }, worker),
  );

  if (files.length === 0) {
    console.log(
      `No test files to run (diff vs ${TEST_DIFF_BASE} touched none of the collected files).`,
    );
    return;
  }

  console.log(
    `\n${passed} passed, ${failed} failed (${files.length} test files${
      shard ? `, shard ${shard.index}/${shard.total}` : ""
    })`,
  );

  if (failures.length > 0) {
    console.log("\nFailed test files:");
    for (const file of failures) {
      console.log(`  ${file}`);
    }
    process.exit(1);
  }
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
