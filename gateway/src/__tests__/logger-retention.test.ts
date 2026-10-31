import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initLogger, getLogger } from "../logger.js";

// NOTE: `sleep-wake-detector.test.ts` installs a process-global
// `mock.module("../logger.js", …)` with a no-op `initLogger`. Run gateway
// tests through the canonical runner (`bun run test`) — per-file processes
// dodge that class of mock cross-talk.

describe("gateway logger file output", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gw-logger-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test("getLogger() writes into a configured dir without throwing", () => {
    // Log retention was removed outright (field feedback item 8 — the
    // first-boot prune stretched every wake); the daily file roll stays.
    initLogger({ dir: tmp });
    const log = getLogger("retention-test");
    log.info("hello");
    expect(existsSync(tmp)).toBe(true);
    expect(readdirSync(tmp).length).toBeGreaterThan(0);
  });
});
