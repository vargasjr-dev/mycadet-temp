#!/usr/bin/env bun
/**
 * Test runner with full process isolation for Bun mock.module conflicts.
 *
 * Bun's mock.module is process-global: the last mock.module call for a given
 * specifier wins across ALL test files in the process. Test files that mock a
 * module would otherwise break test files that need the real implementation,
 * so each test file runs in its own Bun process. Files run in parallel
 * (configurable via TEST_WORKERS, default: CPU count).
 *
 * This is the Bun port of the former scripts/test.sh, kept in lockstep with
 * the assistant's scripts/test.ts: same fail-open diff scoping, same
 * per-file timeout + retry-once-on-no-evidence classification, same failure
 * reporting. Assistant-only machinery (experimental filters, coverage merge,
 * durations/sharding, bundled-catalog sync, DB fixtures) is intentionally
 * absent until the gateway has a consumer for it.
 *
 * Diff scoping: with TEST_DIFF_ONLY=true, run only the test files changed vs
 * TEST_DIFF_BASE (default origin/main). When the diff cannot be computed
 * (base ref not fetched, detached checkout), fall back to the full suite
 * rather than silently skipping anything. dev-release runs the full suite
 * (env unset); pr-gateway scopes to the PR's changes.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const WORKERS =
  Number.parseInt(Bun.env.TEST_WORKERS ?? "", 10) ||
  navigator.hardwareConcurrency ||
  8;
// Per-test timeout (seconds). Kills bun processes that pass but don't exit
// due to open handles.
const PER_TEST_TIMEOUT = Number.parseInt(Bun.env.PER_TEST_TIMEOUT ?? "120", 10);
// SIGKILL grace after SIGTERM, mirroring `timeout -k 10`.
const KILL_GRACE_MS = 10_000;
// Per-test timeout bun applies to each individual test() call. Sized for
// unstarved machines; under concurrent per-file workers wall-clock per test
// runs longer. Tune via env.
const BUN_TEST_TIMEOUT_MS = Number.parseInt(
  Bun.env.BUN_TEST_TIMEOUT ?? "15000",
  10,
);
// Run only test files changed vs TEST_DIFF_BASE; fails open when the diff
// cannot be computed.
const TEST_DIFF_ONLY = Bun.env.TEST_DIFF_ONLY === "true";
const TEST_DIFF_BASE = Bun.env.TEST_DIFF_BASE ?? "origin/main";

// ---------------------------------------------------------------------------
// Test-file collection
// ---------------------------------------------------------------------------

function collectTestFiles(): string[] {
  const glob = new Bun.Glob("src/**/*.test.ts");
  const files: string[] = [];
  for (const file of glob.scanSync(".")) {
    files.push(file);
  }
  return files.sort();
}

// Intersect collected test files with those changed vs the base ref.
function diffTestFiles(files: string[]): string[] | null {
  const repoRoot = join(import.meta.dir, "..", "..");
  const proc = Bun.spawnSync(
    [
      "git",
      "diff",
      "--name-only",
      `${TEST_DIFF_BASE}...HEAD`,
      "--",
      "gateway/src",
    ],
    { cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
  );
  if (proc.exitCode !== 0) {
    return null;
  }
  const changed = new Set(
    proc.stdout
      .toString()
      .split("\n")
      .filter(Boolean)
      .map((p) => p.replace(/^gateway\//, "")),
  );
  return files.filter((f) => changed.has(f));
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

async function runBunTest(file: string): Promise<RunResult> {
  const proc = Bun.spawn(
    [
      "bun",
      "test",
      `--timeout=${BUN_TEST_TIMEOUT_MS}`,
      file,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );

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
  }, PER_TEST_TIMEOUT * 1000);

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
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

async function runOneFile(
  file: string,
): Promise<FileResult> {
  const base = basename(file);

  const start = performance.now();
  let { exitCode, output, timedOut } = await runBunTest(file);

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
        retryReason = `hung after ${PER_TEST_TIMEOUT}s without completing`;
      }
    } else {
      retryReason = `transient crash, exit ${exitCode}`;
    }
  }
  if (retryReason) {
    console.log(`  ↻ ${base} (${retryReason} — retrying once)`);
    ({ exitCode, output, timedOut } = await runBunTest(file));
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
      line = `  ✗ ${base} (killed after ${PER_TEST_TIMEOUT}s — tests failed and process hung)`;
    } else if (reachedEndOfRun(output)) {
      outcome = "hung-pass";
      line = `  ⚠ ${base} (tests passed but process hung after ${PER_TEST_TIMEOUT}s — likely open handles)`;
    } else {
      outcome = "fail";
      line = `  ✗ ${base} (killed after ${PER_TEST_TIMEOUT}s — test run did not complete)`;
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
// Concurrency pool
// ---------------------------------------------------------------------------

async function runPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const runner = async (): Promise<void> => {
    while (true) {
      const idx = next++;
      if (idx >= items.length) {
        return;
      }
      results[idx] = await worker(items[idx]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, runner),
  );
  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  let testFiles = collectTestFiles();
  if (testFiles.length === 0) {
    console.log("No test files found under src");
    process.exit(1);
  }
  if (TEST_DIFF_ONLY) {
    const scoped = diffTestFiles(testFiles);
    if (scoped === null) {
      console.log(
        `TEST_DIFF_ONLY set but the diff vs ${TEST_DIFF_BASE} could not be computed — running the full suite`,
      );
    } else if (scoped.length === 0) {
      console.log(
        `No test files changed vs ${TEST_DIFF_BASE} — nothing to run`,
      );
      process.exit(0);
    } else {
      console.log(
        `Diff-scoped run: ${scoped.length} of ${testFiles.length} test file(s) changed vs ${TEST_DIFF_BASE}`,
      );
      testFiles = scoped;
    }
  }

  console.log(`Running ${testFiles.length} test files (${WORKERS} workers)`);

  const resultsDir = mkdtempSync(join(tmpdir(), "cadet-gateway-test-run-"));

  try {
    const results = await runPool(testFiles, WORKERS, (f) => runOneFile(f));

    const failures = results.filter((r) => r.outcome === "fail");
    if (failures.length > 0) {
      console.log("");
      for (const r of failures) {
        console.log("──────────────────────────────────────────");
        console.log(`FAIL: ${r.file}`);
        console.log("──────────────────────────────────────────");
        process.stdout.write(r.output);
        console.log("");
      }
      console.log("========================================");
      console.log(`  FAILED TEST FILES (${failures.length}):`);
      console.log("========================================");
      for (const r of failures) {
        console.log(`  ✗ ${r.file}`);
      }
      console.log("========================================");
      process.exit(1);
    }

    console.log(`All ${testFiles.length} test files passed`);
  } finally {
    rmSync(resultsDir, { recursive: true, force: true });
  }
}

await main();
