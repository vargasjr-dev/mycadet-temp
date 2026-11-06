/**
 * Package-level test preload — runs before any test file's module body.
 *
 * Every test file in this package shares one process and one module loader,
 * and the scheduler interleaves files: a suite's per-test `mock.module` of a
 * shared module (../process, ../daemon-readiness) can be the live registry
 * entry at the moment ANOTHER file's graph links its imports. Files that
 * need the real implementation of a mocked module therefore cannot trust a
 * snapshot taken at their own load time.
 *
 * This preload runs before all of them, so the snapshots taken here are
 * guaranteed to be the untouched real modules. Suites re-register from these
 * globals; nothing here registers anything.
 */

import * as processReal from "./src/process";
import * as daemonReadinessReal from "./src/daemon-readiness";

const globals = globalThis as typeof globalThis & {
  __cadetRealProcess?: typeof processReal;
  __cadetRealDaemonReadiness?: typeof daemonReadinessReal;
};

globals.__cadetRealProcess ??= processReal;
globals.__cadetRealDaemonReadiness ??= daemonReadinessReal;
