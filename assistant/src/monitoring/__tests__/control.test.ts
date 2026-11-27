/**
 * Tests for the resource monitor process control surface.
 *
 * Focuses on the readiness wait (which gates whether `assistant monitoring
 * start` reports success) and the PID-file liveness probe, mirroring the
 * memory worker's worker-control tests.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// Captured at module scope: the preload cleans up its env var between suites.
const PRELOAD_WS = process.env.CADET_WORKSPACE_DIR!;

let tmpDir: string;
let pidPath: string;

const {
  spawnMonitoringWorkerProcess,
  MonitoringWorkerSpawnError,
  probeMonitoringWorker,
  stopMonitoringWorkerProcess,
} = await import("../control.js");

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
      const err: NodeJS.ErrnoException = new Error("kill EPERM");
      err.code = "EPERM";
      throw err;
    }
    if (livePids.has(pid)) {
      return true;
    }
    const err: NodeJS.ErrnoException = new Error("kill ESRCH");
    err.code = "ESRCH";
    throw err;
  };
  return () => {
    process.kill = original;
  };
}

function stubBunSpawn(
  makeChild: () => {
    unref: () => void;
    kill: () => void;
    pid: number;
    exited?: Promise<unknown>;
  },
): () => void {
  const original = Bun.spawn;
  Bun.spawn = (() => makeChild()) as unknown as typeof Bun.spawn;
  return () => {
    Bun.spawn = original;
  };
}

function neverExits(): Promise<unknown> {
  return new Promise(() => {});
}

// A PID no process can ever have — above every platform's pid_max — so the
// identity probe's command-line read is deterministically unreadable. A
// hand-picked small PID (4321) made these tests flaky: on runners where that
// PID happened to be live, the probe correctly reported a recycled PID
// (not_running) instead of "running".
const UNASSIGNABLE_PID = 2_147_483_646;

beforeEach(() => {
  // The preload's workspace already resolves <workspace>/data/monitoring.
  tmpDir = PRELOAD_WS;
  mkdirSync(join(tmpDir, "data", "monitoring"), { recursive: true });
  pidPath = join(tmpDir, "data", "monitoring", "monitoring.pid");
});

afterEach(() => {
  rmSync(join(tmpDir, "data", "monitoring"), { recursive: true, force: true });
});

describe("spawnMonitoringWorkerProcess", () => {
  test("returns the PID when the monitor writes its file immediately", async () => {
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
      const result = await spawnMonitoringWorkerProcess({
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
        spawnMonitoringWorkerProcess({
          pidWaitTimeoutMs: 10_000,
          pidPollIntervalMs: 10,
          terminateOnTimeout: true,
        }),
      ).rejects.toBeInstanceOf(MonitoringWorkerSpawnError);
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
        spawnMonitoringWorkerProcess({
          pidWaitTimeoutMs: 150,
          pidPollIntervalMs: 20,
          terminateOnTimeout: true,
        }),
      ).rejects.toBeInstanceOf(MonitoringWorkerSpawnError);
      expect(killed).toBe(true);
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
      const result = await spawnMonitoringWorkerProcess({
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

describe("probeMonitoringWorker", () => {
  test("reports not_running when no PID file exists", () => {
    expect(probeMonitoringWorker()).toEqual({ status: "not_running" });
  });

  test("cleans up a stale PID file pointing at a dead process", () => {
    writeFileSync(pidPath, "999999");
    const restore = stubProcessKill(new Set());
    try {
      expect(probeMonitoringWorker()).toEqual({ status: "not_running" });
    } finally {
      restore();
    }
  });

  test("reports not_running when the PID file names a live process that is not this worker", () => {
    writeFileSync(pidPath, String(process.pid));
    expect(probeMonitoringWorker()).toEqual({ status: "not_running" });
  });

  test("reports running (not throws) when the process exists but is not signalable (EPERM)", () => {
    writeFileSync(pidPath, String(UNASSIGNABLE_PID));
    const restore = stubProcessKill(new Set(), new Set([UNASSIGNABLE_PID]));
    try {
      expect(probeMonitoringWorker()).toEqual({
        status: "running",
        pid: UNASSIGNABLE_PID,
      });
    } finally {
      restore();
    }
  });
});

describe("stopMonitoringWorkerProcess", () => {
  test("is a no-op when the monitor is not running", () => {
    expect(stopMonitoringWorkerProcess()).toEqual({ status: "not_running" });
  });

  test("signals a running monitor and reports its prior state", () => {
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
      expect(stopMonitoringWorkerProcess()).toEqual({
        status: "running",
        pid: UNASSIGNABLE_PID,
      });
      expect(signalled).toEqual([[UNASSIGNABLE_PID, "SIGTERM"]]);
    } finally {
      process.kill = original;
    }
  });
});
