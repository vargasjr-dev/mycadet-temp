#!/usr/bin/env bun
/**
 * Assistant test entrypoint. All orchestration (process isolation, diff
 * scoping, wall-clock timeout + retry, durations/sharding, coverage merge,
 * fixtures) lives in @mycadet/shared's run-isolated-tests, shared with the
 * gateway and the other package suites. This file only carries the
 * assistant's specifics: the bundled-catalog sync, the known-broken and
 * experimental file lists, and the pre-migrated DB fixture.
 */

import { basename } from "node:path";

import { runIsolatedTests } from "@mycadet/shared/scripts/run-isolated-tests";

const EXCLUDE_EXPERIMENTAL = Bun.env.EXCLUDE_EXPERIMENTAL === "true";

const EXPERIMENTAL_FILES = new Set([
  "skill-load-tool.test.ts",
  "memory-regressions.experimental.test.ts",
]);

// Tests that exist in the tree but are known-broken when run. Excluded
// unconditionally until triage lands a fix for each. Entries must be
// repo-relative paths (matching by basename would silently exclude every copy
// of ambiguous names like `connect.test.ts` that recur under multiple
// `src/cli/commands/*/__tests__/` directories). To triage: run
// `bun test <path>` and fix until green, then remove it here.
const KNOWN_BROKEN_FILES = new Set<string>([
  // Stale guard: PR #5 (docs trim) removed the .claude/skills/ tree and the
  // README lifecycle section this guard enforces. The rebrand workstream
  // owns rewriting it for the new canonical commands.
  "src/__tests__/lifecycle-docs-guard.test.ts",
  // QuickJS asyncify state wedges after an in-flight OOM/interrupt abort,
  // hanging the file until the per-file kill. Reproduces on main outside
  // CI; tracked separately from CI infra.
  "src/workflows/sandbox-escape.test.ts",
  // The long-await CPU-guard reset tests. They pass by hand (including
  // pinned to 2 cores), but under CI's concurrent per-file workers the
  // asyncify resume can be starved past the per-test cap and the host
  // promise's resumption is lost — the same 0.32.0 asyncify fragility as
  // sandbox-escape above. Split out of sandbox.test.ts so the rest of that
  // file keeps running in CI. To triage: fix the asyncify wedge, then run
  // `bun test src/workflows/sandbox-cpu-guard-asyncify.test.ts` until green
  // and remove this entry.
  "src/workflows/sandbox-cpu-guard-asyncify.test.ts",
]);

await runIsolatedTests({
  filter: (file) => {
    const base = basename(file);
    // Always exclude benchmark files — run them with `bun run test:bench`.
    if (base.endsWith(".benchmark.test.ts")) {
      return false;
    }
    if (KNOWN_BROKEN_FILES.has(file)) {
      return false;
    }
    if (EXCLUDE_EXPERIMENTAL && EXPERIMENTAL_FILES.has(base)) {
      return false;
    }
    return true;
  },
  bunTestArgs: EXCLUDE_EXPERIMENTAL
    ? ["--test-name-pattern", "^(?!.*\\[experimental\\])"]
    : [],
  fixture: {
    script: "scripts/build-test-fixtures.ts",
    envVar: "CADET_TEST_FIXTURES_DIR",
  },
});
