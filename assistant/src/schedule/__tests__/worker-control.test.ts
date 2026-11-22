/**
 * Tests for the schedule worker process control surface.
 *
 * Focuses on the readiness wait (which gates whether the daemon's boot spawn
 * reports the worker up) and the PID-file liveness probe, mirroring the memory
 * worker's worker-control tests.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";

import { fakeSubprocess } from "../../__tests__/helpers/spawn-stub.js";

// Captured at module scope: the preload cleans up its env var between suites.
const PRELOAD_WS = process.env.CADET_WORKSPACE_DIR!;

let tmpDir: string;
let pidPath: string;

const {
  spawnScheduleWorkerProcess,
  ScheduleWorkerSpawnError,
  probeScheduleWorker,
  stopScheduleWorkerProcess,
} = await import("../worker-control.js");

function stubProcessKill(
  livePids: Set<number>,
  permissionErrorPids: Set<number> = new Set(),
): () => void {
  const original = process.kill.bind(process);
  process.kill = (pid: number, signal?: string | number) => {
    if ((signal ?? 0) !== 0) {
      return true;
    }
    if (permissionErrorPids.has(pid)) {
      const err = Object.assign(new Error("kill EPERM"), { code: "EPERM" });
      throw err;
    }
    if (livePids.has(pid)) {
      return true;
    }
    const err = Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    throw err;
  };
  return () => {
    process.kill = original;
  };
}

function stubBunSpawn(
  makeChild: () => {
    pid: number;
    exited?: Promise<number>;
    kill?: () => void;
    unref?: () => void;
  },
): () => void {
  const original = Bun.spawn;
  // Bun.spawn's type is the generic-overload pair; the worker path only ever
  // takes the options-object form, so the double asserts through that
  // signature and every OTHER member of the double is genuinely typed
  // (fakeSubprocess builds a real Subprocess shape).
  Bun.spawn = ((..._args: Parameters<typeof Bun.spawn>) =>
    fakeSubprocess(makeChild())) as typeof Bun.spawn;
  return () => {
    Bun.spawn = original;
  };
}

function neverExits(): Promise<number> {
  return new Promise(() => {});
}

// A PID no process can ever have — above every platform's pid_max — so the
// identity probe's command-line read is deterministically unreadable. A
// hand-picked small PID (4321) made these tests flaky: on runners where that
// PID happened to be live, the probe correctly reported a recycled PID
// (not_running) instead of "running".
const UNASSIGNABLE_PID = 2_147_483_646;

beforeEach(() => {
  // The preload's workspace already resolves <workspace>/schedule-worker.pid.
  tmpDir = PRELOAD_WS;
  pidPath = join(tmpDir, "schedule-worker.pid");
});

describe("spawnScheduleWorkerProcess", () => {
  test("returns the PID when the worker writes its file immediately", async () => {
    const restore = stubBunSpawn(() => {
      writeFileSync(pidPath, "4242");
      return {
        unref: () => {},
        kill: () => {},
        pid: 4242,
        exited: neverExits(),
      };
    });
    try {
      const result = await spawnScheduleWorkerProcess({
        pidWaitTimeoutMs: 1_000,
        pidPollIntervalMs: 10,
      });
      expect(result).toEqual({ pid: 4242, alreadyRunning: false });
    } finally {
      restore();
    }
  });

  test("fails fast when the child exits during startup", async () => {
    let killed = false;
    const restore = stubBunSpawn(() => ({
      unref: () => {},
      kill: () => {
        killed = true;
      },
      pid: 99,
      exited: Promise.resolve(1),
    }));
    try {
      await expect(
        spawnScheduleWorkerProcess({
          pidWaitTimeoutMs: 10_000,
          pidPollIntervalMs: 10,
          terminateOnTimeout: true,
        }),
      ).rejects.toBeInstanceOf(ScheduleWorkerSpawnError);
      expect(killed).toBe(false);
    } finally {
      restore();
    }
  });

  test("terminates a still-alive child on timeout when asked", async () => {
    let killed = false;
    const restore = stubBunSpawn(() => ({
      unref: () => {},
      kill: () => {
        killed = true;
      },
      pid: 55,
      exited: neverExits(),
    }));
    try {
      await expect(
        spawnScheduleWorkerProcess({
          pidWaitTimeoutMs: 150,
          pidPollIntervalMs: 20,
          terminateOnTimeout: true,
        }),
      ).rejects.toBeInstanceOf(ScheduleWorkerSpawnError);
      expect(killed).toBe(true);
    } finally {
      restore();
    }
  });

  test("coalesces concurrent spawns onto a single OS process", async () => {
    let spawnCount = 0;
    let writePidFile: () => void = () => {};
    const restore = stubBunSpawn(() => {
      spawnCount++;
      // A cold worker writes its PID file only after the caller has started
      // waiting, so a racing spawn cannot see it via the PID-file guard.
      writePidFile = () => writeFileSync(pidPath, "4242");
      return {
        unref: () => {},
        kill: () => {},
        pid: 4242,
        exited: neverExits(),
      };
    });
    try {
      // The daemon's boot spawn goes in flight before the worker writes its PID.
      const boot = spawnScheduleWorkerProcess({
        pidWaitTimeoutMs: 1_000,
        pidPollIntervalMs: 5,
      });
      // The watchdog's first tick fires a second spawn during that window.
      const watchdog = spawnScheduleWorkerProcess({
        pidWaitTimeoutMs: 1_000,
        pidPollIntervalMs: 5,
      });
      writePidFile(); // the single worker finally reports readiness
      const [bootResult, watchdogResult] = await Promise.all([boot, watchdog]);

      expect(spawnCount).toBe(1); // only one OS process was ever started
      expect(bootResult).toEqual({ pid: 4242, alreadyRunning: false });
      // The coalesced caller reports alreadyRunning so the watchdog logs no
      // spurious respawn for the boot spawn's worker.
      expect(watchdogResult).toEqual({ pid: 4242, alreadyRunning: true });
    } finally {
      restore();
    }
  });

  test("spawns when the PID file names an unrelated live process", async () => {
    writeFileSync(pidPath, String(process.pid));
    let spawned = false;
    const restore = stubBunSpawn(() => {
      spawned = true;
      writeFileSync(pidPath, "4242");
      return {
        unref: () => {},
        kill: () => {},
        pid: 4242,
        exited: neverExits(),
      };
    });
    try {
      const result = await spawnScheduleWorkerProcess({
        pidWaitTimeoutMs: 1_000,
        pidPollIntervalMs: 10,
      });
      expect(result).toEqual({ pid: 4242, alreadyRunning: false });
      expect(spawned).toBe(true);
    } finally {
      restore();
    }
  });
});

describe("probeScheduleWorker", () => {
  test("reports not_running when no PID file exists", () => {
    expect(probeScheduleWorker()).toEqual({ status: "not_running" });
  });

  test("cleans up a stale PID file pointing at a dead process", () => {
    writeFileSync(pidPath, "999999");
    const restore = stubProcessKill(new Set());
    try {
      expect(probeScheduleWorker()).toEqual({ status: "not_running" });
    } finally {
      restore();
    }
  });

  test("reports not_running when the PID file names a live process that is not this worker", () => {
    writeFileSync(pidPath, String(process.pid));
    expect(probeScheduleWorker()).toEqual({ status: "not_running" });
  });

  test("reports running (not throws) when the process exists but is not signalable (EPERM)", () => {
    writeFileSync(pidPath, String(UNASSIGNABLE_PID));
    const restore = stubProcessKill(new Set(), new Set([UNASSIGNABLE_PID]));
    try {
      expect(probeScheduleWorker()).toEqual({
        status: "running",
        pid: UNASSIGNABLE_PID,
      });
    } finally {
      restore();
    }
  });
});

describe("stopScheduleWorkerProcess", () => {
  test("is a no-op when the worker is not running", () => {
    expect(stopScheduleWorkerProcess()).toEqual({ status: "not_running" });
  });

  test("does not signal a recycled PID that is not this worker", () => {
    writeFileSync(pidPath, String(process.pid));
    const signalled: Array<[number, string | number | undefined]> = [];
    const original = process.kill.bind(process);
    process.kill = (pid: number, signal?: string | number) => {
      if ((signal ?? 0) === 0) {
        return original(pid, signal);
      }
      signalled.push([pid, signal]);
      return true;
    };
    try {
      expect(stopScheduleWorkerProcess()).toEqual({ status: "not_running" });
      expect(signalled).toEqual([]);
    } finally {
      process.kill = original;
    }
  });

  test("signals a running worker and reports its prior state", () => {
    writeFileSync(pidPath, String(UNASSIGNABLE_PID));
    const signalled: Array<[number, string | number | undefined]> = [];
    const original = process.kill.bind(process);
    process.kill = (pid: number, signal?: string | number) => {
      if ((signal ?? 0) === 0) {
        return true;
      } // liveness probe
      signalled.push([pid, signal]);
      return true;
    };
    try {
      expect(stopScheduleWorkerProcess()).toEqual({
        status: "running",
        pid: UNASSIGNABLE_PID,
      });
      expect(signalled).toEqual([[UNASSIGNABLE_PID, "SIGTERM"]]);
    } finally {
      process.kill = original;
    }
  });
});
