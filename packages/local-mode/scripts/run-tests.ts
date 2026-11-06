#!/usr/bin/env bun
/**
 * Local-mode test entrypoint — per-file process isolation via the shared
 * runner (mock.module leaks across files in one process; CI's other suites
 * already run this way). Single-file runs stay direct: one file in one
 * process IS the isolation, so `bun test src/lockfile-contract.test.ts`
 * from this package matches what the runner would do for that file.
 */

import { runIsolatedTests } from "@mycadet/shared/scripts/run-isolated-tests";

await runIsolatedTests();
