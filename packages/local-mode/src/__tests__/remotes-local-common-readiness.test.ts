import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import {
  type DaemonSpawn,
  isStartupLoggingEnabled,
  reportFreshSpawnReadiness,
  setStartupLogging,
} from "../remotes/local/common";

// Above every platform default pid ceiling, so no live process owns it.
const DEAD_PID = 999999;
// No daemon listens here, so port ownership can never be confirmed and the
// settle window decides the outcome.
const UNSERVED_PORT = 7999;

describe("reportFreshSpawnReadiness", () => {
  let tempDir: string;
  let pidFile: string;
  let logSpy: ReturnType<typeof spyOn>;

  const spawnHandle = (exited: boolean): DaemonSpawn => ({
    hasExited: () => exited,
  });

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "cadet-readiness-"));
    pidFile = join(tempDir, "daemon.pid");
    // The ready line is the one startup line behind the verbosity gate —
    // these tests assert the operator-visible default, so pin the gate on
    // (a sibling suite that runs the real hatch leg flips it off).
    setStartupLogging(true);
    logSpy = spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("reports the readiness of a daemon that survived its spawn", async () => {
    /**
     * Tests that a daemon still running after the settle window has its
     * probed state reported.
     */

    // GIVEN the spawned daemon is running — a real child process, so the
    // liveness probe is unambiguous even while the runner's own pid is
    // doing whatever the parallel test scheduler has it do
    const daemon = Bun.spawn(["sleep", "5"]);
    writeFileSync(pidFile, String(daemon.pid), "utf-8");

    try {
      // WHEN its readiness is reported
      await reportFreshSpawnReadiness(
        spawnHandle(false),
        pidFile,
        UNSERVED_PORT,
        "ready",
      );

      // THEN the probed state reaches the operator — if this ever fails,
      // say which mechanism swallowed it: the verbosity gate, or a settle
      // verdict that took the failure branch instead
      expect(isStartupLoggingEnabled()).toBeTrue();
      expect(
        logSpy.mock.calls.map((call: Parameters<typeof console.log>) =>
          call.join(" "),
        ),
      ).not.toContain(expect.stringContaining("⚠️"));
      expect(logSpy).toHaveBeenCalledWith("   Assistant ready\n");
    } finally {
      daemon.kill();
    }
  });

  test("reports a startup failure instead of a probe answered by a foreign listener", async () => {
    /**
     * Tests that a daemon which aborted during startup is reported as not
     * running, even when the probe reports it as up.
     */

    // GIVEN the spawned daemon exited, while a foreign listener holding its
    // runtime HTTP port answered the readiness probe in its place
    writeFileSync(pidFile, String(DEAD_PID), "utf-8");

    // WHEN its readiness is reported
    await reportFreshSpawnReadiness(
      spawnHandle(true),
      pidFile,
      UNSERVED_PORT,
      "migrating",
    );

    // THEN the failure is reported rather than the probe's optimistic state
    expect(logSpy).toHaveBeenCalledWith(
      "   ⚠️  Assistant exited during startup and is not running\n",
    );
    expect(logSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("database migrations still running"),
    );
  });

  test("reports a startup failure when the spawn dies during the settle window", async () => {
    /**
     * Tests that a daemon which is still alive when its readiness is probed,
     * and aborts moments later, is reported as not running.
     */

    // GIVEN a spawn that is alive when reported and exits shortly after
    writeFileSync(pidFile, String(process.pid), "utf-8");
    let exited = false;
    const spawn: DaemonSpawn = { hasExited: () => exited };
    setTimeout(() => {
      exited = true;
    }, 150);

    // WHEN its readiness is reported
    await reportFreshSpawnReadiness(spawn, pidFile, UNSERVED_PORT, "ready");

    // THEN the failure is reported rather than the probe's optimistic state
    expect(logSpy).toHaveBeenCalledWith(
      "   ⚠️  Assistant exited during startup and is not running\n",
    );
    expect(logSpy).not.toHaveBeenCalledWith("   Assistant ready\n");
  });

  test("throws for a failed spawn when the caller requires readiness", async () => {
    /**
     * Tests that callers which cannot continue without a running assistant
     * (hatch) fail rather than proceeding on a foreign listener's probe.
     */

    // GIVEN the spawned daemon exited and the caller requires readiness
    writeFileSync(pidFile, String(DEAD_PID), "utf-8");

    // WHEN its readiness is reported
    const report = reportFreshSpawnReadiness(
      spawnHandle(true),
      pidFile,
      UNSERVED_PORT,
      "ready",
      true,
    );

    // THEN startup fails loudly
    await expect(report).rejects.toThrow("exited during startup");
  });
});
