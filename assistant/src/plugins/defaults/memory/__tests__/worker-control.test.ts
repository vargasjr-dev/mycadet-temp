/**
 * Tests for `spawnMemoryWorkerProcess` — the worker-process spawner.
 *
 * Focuses on the readiness wait, which gates whether the daemon's boot spawn
 * reports the worker up:
 *   - succeeds when the worker writes its PID file (immediately or a little
 *     late — a cold `bun run` start takes seconds),
 *   - fails fast when the child exits during startup,
 *   - on timeout, terminates a still-alive child only when asked.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";
import {} from "bun:test";

// Captured at module scope: the preload cleans up its env var between suites.
const PRELOAD_WS = process.env.VELLUM_WORKSPACE_DIR!;

let tmpDir: string;
let pidPath: string;

const { spawnMemoryWorkerProcess, MemoryWorkerSpawnError, probeMemoryWorker } =
  await import("../worker-control.js");

/**
 * Replace process.kill with a stub. `signal 0` (liveness) resolves for
 * `livePids`, throws ESRCH otherwise — unless `permissionErrorPids` includes
 * the pid, in which case it throws EPERM ("exists but not signalable").
 */
function stubProcessKill(
  livePids: Set<number>,
  permissionErrorPids: Set<number> = new Set(),
): () => void {
  const original = process.kill.bind(process);
  process.kill = ((pid: number, signal?: string | number) => {
    if ((signal ?? 0) !== 0) {
      return true;
    }
    if (permissionErrorPids.has(pid)) {
      const err = new Error("kill EPERM") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    }
    if (livePids.has(pid)) {
      return true;
    }
    const err = new Error("kill ESRCH") as NodeJS.ErrnoException;
    err.code = "ESRCH";
    throw err;
  }) as typeof process.kill;
  return () => {
    process.kill = original;
  };
}

/**
 * Install a stub `Bun.spawn`. The `onSpawn` callback receives the resolved PID
 * path so a test can simulate the worker writing its PID file (now or later),
 * and returns the fake child handle.
 */
function stubBunSpawn(
  makeChild: () => {
    unref: () => void;
    kill: () => void;
    pid: number;
    exited?: Promise<unknown>;
  },
): () => void {
  const original = Bun.spawn;
  (Bun as { spawn: typeof Bun.spawn }).spawn = (() =>
    makeChild()) as unknown as typeof Bun.spawn;
  return () => {
    (Bun as { spawn: typeof Bun.spawn }).spawn = original;
  };
}

/** A promise that never resolves — stands in for a still-alive child. */
function neverExits(): Promise<unknown> {
  return new Promise(() => {});
}

beforeEach(() => {
  // The preload's workspace already resolves <workspace>/memory-worker.pid.
  tmpDir = PRELOAD_WS;
  pidPath = join(tmpDir, "memory-worker.pid");
});

describe("spawnMemoryWorkerProcess", () => {
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
      const result = await spawnMemoryWorkerProcess({
        pidWaitTimeoutMs: 1_000,
        pidPollIntervalMs: 10,
      });
      expect(result).toEqual({ pid: 4242, alreadyRunning: false });
    } finally {
      restore();
    }
  });

  test("succeeds when the worker writes its PID file slightly late", async () => {
    const restore = stubBunSpawn(() => {
      // Worker takes ~120ms to come up — would have failed under the old 1s/10x
      // loop's tight window only if shorter; here we prove the wait spans it.
      setTimeout(() => writeFileSync(pidPath, "777"), 120);
      return {
        unref: () => {},
        kill: () => {},
        pid: 777,
        exited: neverExits(),
      };
    });
    try {
      const result = await spawnMemoryWorkerProcess({
        pidWaitTimeoutMs: 2_000,
        pidPollIntervalMs: 20,
      });
      expect(result).toEqual({ pid: 777, alreadyRunning: false });
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
      // Never writes a PID file; exits immediately.
      exited: Promise.resolve(1),
    }));
    try {
      await expect(
        spawnMemoryWorkerProcess({
          // Long timeout so the test only passes if early-exit short-circuits it.
          pidWaitTimeoutMs: 10_000,
          pidPollIntervalMs: 10,
          terminateOnTimeout: true,
        }),
      ).rejects.toBeInstanceOf(MemoryWorkerSpawnError);
      // It exited on its own — nothing to terminate.
      expect(killed).toBe(false);
    } finally {
      restore();
    }
  });

  test("terminates a still-alive child on timeout when terminateOnTimeout is set", async () => {
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
        spawnMemoryWorkerProcess({
          pidWaitTimeoutMs: 150,
          pidPollIntervalMs: 20,
          terminateOnTimeout: true,
        }),
      ).rejects.toBeInstanceOf(MemoryWorkerSpawnError);
      expect(killed).toBe(true);
    } finally {
      restore();
    }
  });

  test("does not terminate the child on timeout when terminateOnTimeout is false", async () => {
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
        spawnMemoryWorkerProcess({
          pidWaitTimeoutMs: 150,
          pidPollIntervalMs: 20,
          terminateOnTimeout: false,
        }),
      ).rejects.toBeInstanceOf(MemoryWorkerSpawnError);
      expect(killed).toBe(false);
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
      const result = await spawnMemoryWorkerProcess({
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

describe("probeMemoryWorker", () => {
  test("reports not_running when the PID file names a live process that is not this worker", () => {
    writeFileSync(pidPath, String(process.pid));
    expect(probeMemoryWorker()).toEqual({ status: "not_running" });
  });

  test("reports running (not throws) when the process exists but is not signalable (EPERM)", () => {
    writeFileSync(pidPath, "4321");
    const restore = stubProcessKill(new Set(), new Set([4321]));
    try {
      expect(probeMemoryWorker()).toEqual({ status: "running", pid: 4321 });
    } finally {
      restore();
    }
  });
});
