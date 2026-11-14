import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  appServerLogPath,
  getAppServerPaths,
} from "../../lib/servers/common.js";

const originalDataHome = process.env.XDG_DATA_HOME;
const originalEnvironment = process.env.CADET_ENVIRONMENT;

function useIsolatedDataHome(): string {
  const home = mkdtempSync(join(tmpdir(), "app-server-log-"));
  process.env.XDG_DATA_HOME = home;
  process.env.CADET_ENVIRONMENT = "test";
  return home;
}

describe("appServerLogPath", () => {
  afterEach(() => {
    if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalDataHome;
    if (originalEnvironment === undefined) delete process.env.CADET_ENVIRONMENT;
    else process.env.CADET_ENVIRONMENT = originalEnvironment;
  });

  test("names the file by the local calendar day", () => {
    // Local-time constructors keep the assertion timezone-proof.
    const noon = new Date(2026, 10, 14, 12, 0, 0);
    const lateNight = new Date(2026, 10, 14, 23, 59, 59);
    for (const moment of [noon, lateNight]) {
      expect(appServerLogPath(moment).endsWith("app-2026-11-14.log")).toBe(
        true,
      );
    }
  });

  test("rolls per day under the data dir's app-server/logs", () => {
    const beforeMidnight = appServerLogPath(new Date(2026, 10, 14, 23, 59));
    const afterMidnight = appServerLogPath(new Date(2026, 10, 15, 0, 0));
    expect(beforeMidnight).not.toBe(afterMidnight);
    for (const path of [beforeMidnight, afterMidnight]) {
      expect(path).toContain(join("app-server", "logs"));
    }
  });

  test("lives under the environment's XDG data home", () => {
    const home = useIsolatedDataHome();
    const path = appServerLogPath(new Date(2026, 0, 2));
    // The data dir carries the environment segment (cadet-test here), so the
    // path starts at the data home and narrows through the app-server logs.
    expect(path.startsWith(home)).toBe(true);
    expect(path).toContain(join("cadet-test", "app-server", "logs"));
    expect(getAppServerPaths().logPath).toBe(appServerLogPath());
  });
});
