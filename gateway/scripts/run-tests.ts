#!/usr/bin/env bun
/**
 * Gateway test entrypoint. All orchestration (process isolation, diff
 * scoping, wall-clock timeout + retry, durations/sharding) lives in
 * @mycadet/shared's run-isolated-tests, shared with the assistant and the
 * other package suites.
 */

import { runIsolatedTests } from "@mycadet/shared/scripts/run-isolated-tests";

await runIsolatedTests();
