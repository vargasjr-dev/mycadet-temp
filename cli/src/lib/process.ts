import { execFileSync } from "child_process";
import { platform } from "os";

import {
  DAEMON_STOP_TIMEOUT_MS,
  isCadetProcess,
  isProcessAlive,
  readProcessCommandLine,
  readWindowsProcesses,
  removeFiles,
  stopProcess,
} from "@mycadet/local-mode";

import {
  httpHealthCheck,
  type HttpProbeEndpoint,
  probeDaemonReadinessWithRetry,
  waitForDaemonReady,
} from "./http-client.js";

// The process-inspection and stop cluster (command-line reads, cadet
// verification, SIGTERM→SIGKILL escalation, PID-file stops) lives in
// `@mycadet/local-mode` now — the lifecycle operations stop processes
// in-process, and one stop contract serves every caller. Import it directly.

export function executableName(
  name: string,
  hostPlatform: NodeJS.Platform = platform(),
): string {
  return hostPlatform === "win32" && !name.endsWith(".exe")
    ? `${name}.exe`
    : name;
}

export function pathListDelimiter(
  hostPlatform: NodeJS.Platform = platform(),
): string {
  return hostPlatform === "win32" ? ";" : ":";
}

/** Discriminated union: when `alive` is true, `pid` is guaranteed non-null. */
export type ProcessHealthResult =
  | { alive: true; healthy: boolean; pid: number }
  | { alive: false; healthy: false; pid: null };

/**
 * Check if a PID file's process is alive AND responding to HTTP health checks.
 *
 * Combines PID existence check with an HTTP `/healthz` probe. A process that
 * exists but does not respond (hung, deadlocked, at 100% CPU) returns
 * `alive: true, healthy: false` — callers should kill and restart it.
 */
export async function isProcessHealthy(
  pidFile: string,
  healthPort: number,
  timeoutMs: number = 3000,
): Promise<ProcessHealthResult> {
  const { alive, pid } = isProcessAlive(pidFile);
  if (!alive || pid === null) {
    return { alive: false, healthy: false, pid: null };
  }

  const healthy = await httpHealthCheck(healthPort, timeoutMs);
  return { alive: true, healthy, pid };
}

/**
 * Outcome of {@link resolveProcessState}. Callers switch on `status`:
 * - `"healthy"` — process is alive and ready; `pid` is the live PID.
 * - `"unready"` — process is alive and healthy, but DB migrations were still
 *   running when the readiness wait elapsed.
 * - `"migration_failed"` — process is alive and healthy, but its DB migrations
 *   failed: a terminal state that never recovers without a restart. The
 *   process is kept alive (same keep-alive rule as `"unready"`).
 * - `"stuck"`: process is unresponsive and could not be terminated.
 * - `"needs_start"`: process was dead, hung (and killed), or a stale PID
 *   was cleaned up. Caller should start a fresh process.
 */
export type ProcessState =
  | { status: "healthy"; pid: number }
  | { status: "unready"; pid: number }
  | { status: "migration_failed"; pid: number }
  | { status: "stuck"; pid: number }
  | { status: "needs_start"; pid: number | null };

/**
 * Determine whether a PID-tracked process is alive and healthy. If the process
 * exists but is unresponsive, waits up to `readinessWaitMs` (default 60s —
 * matches the spawner's own `waitForDaemonReady` timeout so a concurrent
 * caller never kills a process the spawner is still waiting on) for it to
 * start answering health checks. If it remains unresponsive, verifies it
 * belongs to Cadet before killing it, then cleans up the PID file.
 *
 * When callers pass the `"readyz"` readiness endpoint, this also CLASSIFIES
 * DB migration readiness with a single `/readyz` probe (read from the body —
 * the status code stays 200 during migrations for k8s). It never waits for
 * readiness: the kill/keep decision depends only on the health check, and
 * callers that want to wait out a migration own that wait themselves. A
 * health-checking process is kept alive when migrations are running or
 * failed.
 */
export async function resolveProcessState(
  pidFile: string,
  healthPort: number,
  label: string,
  readinessWaitMs: number = 60_000,
  readinessEndpoint: HttpProbeEndpoint = "healthz",
): Promise<ProcessState> {
  const result = await isProcessHealthy(pidFile, healthPort);

  if (!result.alive) {
    return { status: "needs_start", pid: null };
  }

  if (!result.healthy) {
    // Alive but not healthy — may still be starting up.
    const becameHealthy = await waitForDaemonReady(
      healthPort,
      readinessWaitMs,
      "healthz",
    );
    if (!becameHealthy) {
      // Genuinely hung — kill if it belongs to Cadet, otherwise just clean up.
      if (isCadetProcess(result.pid)) {
        console.log(
          `${label} process alive (pid ${result.pid}) but not responding — killing and restarting...`,
        );
        const stopped = await stopProcess(result.pid, label);
        if (!stopped && isProcessAlive(pidFile).alive) {
          return { status: "stuck", pid: result.pid };
        }
      } else {
        console.log(
          `Stale PID file (pid ${result.pid} is not a Cadet process) — cleaning up...`,
        );
      }
      removeFiles(pidFile);
      return { status: "needs_start", pid: result.pid };
    }
  }

  if (readinessEndpoint !== "healthz") {
    const readiness = await probeDaemonReadinessWithRetry(healthPort);
    if (readiness === "failed") {
      return { status: "migration_failed", pid: result.pid };
    }
    if (readiness === "unreachable") {
      // The daemon answered the health check moments ago but not /readyz —
      // it may have died in between (e.g. OOM during a heavy migration).
      // Re-verify liveness before reporting it alive, so callers don't skip
      // starting a replacement for a dead process.
      if (!isProcessAlive(pidFile).alive) {
        removeFiles(pidFile);
        return { status: "needs_start", pid: result.pid };
      }
      return { status: "unready", pid: result.pid };
    }
    if (readiness !== "ready") {
      return { status: "unready", pid: result.pid };
    }
  }

  return { status: "healthy", pid: result.pid };
}

/** Stop a service without escalation. Failure preserves PID tracking and aborts capture/replacement. */
export async function stopProcessGracefully(
  pid: number,
  label: string,
  timeoutMs = DAEMON_STOP_TIMEOUT_MS,
): Promise<boolean> {
  const stopped = await stopProcess(
    pid,
    label,
    timeoutMs,
    undefined,
    undefined,
    undefined,
    true,
  );
  if (!stopped) throw new Error(`${label} did not stop gracefully.`);
  return stopped;
}

/**
 * Find and stop any cadet daemon processes that may not be tracked by a PID
 * file. Scans `ps` output for the `cadet-daemon` binary name.
 *
 * Returns true if at least one process was stopped.
 */
export async function stopOrphanedDaemonProcesses(
  excludePids: ReadonlySet<string> = new Set(),
  hostPlatform: NodeJS.Platform = platform(),
): Promise<boolean> {
  if (hostPlatform === "win32") {
    try {
      const results = await Promise.all(
        readWindowsProcesses()
          .filter(
            ({ imageName, pid }) =>
              pid !== process.pid &&
              !excludePids.has(String(pid)) &&
              (/^cadet-daemon\.exe$/i.test(imageName) ||
                (/^bun\.exe$/i.test(imageName) &&
                  /cadet-daemon|[\\/]assistant[\\/]src[\\/](?:index|daemon[\\/]main)\.ts/i.test(
                    readProcessCommandLine(pid, hostPlatform),
                  ))),
          )
          .map(({ pid }) =>
            stopProcess(pid, "orphaned assistant", 2000, hostPlatform),
          ),
      );
      return results.some(Boolean);
    } catch {
      return false;
    }
  }
  let output: string;
  try {
    output = execFileSync("ps", ["-axww", "-o", "pid=,command="], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
  } catch {
    return false;
  }

  let stopped = false;
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const spaceIdx = trimmed.indexOf(" ");
    if (spaceIdx === -1) continue;
    const pid = parseInt(trimmed.slice(0, spaceIdx), 10);
    if (isNaN(pid) || pid === process.pid || excludePids.has(String(pid))) {
      continue;
    }
    const cmd = trimmed.slice(spaceIdx + 1);

    if (cmd.includes("cadet-daemon")) {
      const result = await stopProcess(pid, "orphaned daemon");
      if (result) stopped = true;
    }
  }
  return stopped;
}
