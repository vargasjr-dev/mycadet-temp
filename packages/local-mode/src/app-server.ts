import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { clearAppProcessRecord } from "./operations/lookup";
import { resolveDataDir, resolveLogDir } from "./config";
import type { LockfileAssistant } from "./lockfile-contract";
import { getGatewayUrl } from "./lockfile-contract";

/**
 * The machine-level app server's read/stop surface — the piece of the CLI's
 * `servers/app-server.ts` the lifecycle operations share. The app server is
 * machine-level (it fronts the active assistant's gateway for every tunnel
 * and wake path) and its state lives under the environment's XDG data dir,
 * never inside an assistant's workspace; the START paths remain the CLI's
 * for now and re-export these readers.
 */

export interface AppServerPaths {
  /** State dir; the pidfile and serve spec live here. */
  dir: string;
  pidPath: string;
  logPath: string;
}

/** The dir pre-rename installs recorded state under (read as a fallback). */
const LEGACY_INGRESS_DIR = "ingress";

export function getAppServerPaths(): AppServerPaths {
  const dir = join(resolveDataDir(), "app-server");
  return {
    dir,
    pidPath: join(dir, "app-server.pid"),
    logPath: join(resolveLogDir(), "app-server.log"),
  };
}

function readPidFile(pidPath: string): number | null {
  try {
    const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check whether a PID belongs to this app server process.
 *
 * Matching only the executable name is not enough: a stale pidfile can point
 * at another assistant's app server after PID reuse. The serve entry runs as
 * its own script, so its command line names our state dir.
 */
function isAppServerProcess(pid: number, paths: AppServerPaths): boolean {
  try {
    const output = execFileSync(
      "ps",
      ["-ww", "-p", String(pid), "-o", "command="],
      {
        encoding: "utf-8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      },
    ).trim();
    return output.includes(paths.dir);
  } catch {
    return false;
  }
}

/** The app server's PID when it is recorded and alive, null otherwise. */
export function getAppServerPid(): number | null {
  const paths = getAppServerPaths();
  const pid = readPidFile(paths.pidPath);
  return pid !== null && isPidAlive(pid) && isAppServerProcess(pid, paths)
    ? pid
    : null;
}

export function isAppServerRunning(): boolean {
  return getAppServerPid() !== null;
}

export interface AppServerState {
  listenPort: number;
  /**
   * Gateway URL the app server proxies to — `getGatewayUrl` of the entry it
   * fronts. Undefined in state records that predate the field; callers treat
   * an unknown upstream as unverified and restart the app server so the
   * running config provably targets the requested gateway and the state is
   * stamped for future comparisons.
   */
  gatewayUrl?: string;
  /**
   * Fingerprint of the injected SPA config and its source bundle. Undefined
   * for records that predate the field; an app server without a recorded
   * fingerprint is treated as drifted and restarted so the served index
   * provably carries the requested config.
   */
  remoteWebConfigHash?: string;
  /**
   * The serve spec the spawned server child reads at boot: the upstream, the
   * dist roots, and the injected documents. Written by the starting parent;
   * the child is stateless beyond it.
   */
  serve?: {
    gatewayUrl: string;
    webDistDir: string;
    appDistDir: string;
    indexHtmlPath: string;
    appIndexHtmlPath: string;
    config: Record<string, unknown>;
  };
}

export function appServerStatePath(): string {
  return join(getAppServerPaths().dir, "state.json");
}

/** The pre-rename state path, read when the renamed one has no record yet. */
function legacyStatePath(): string {
  return join(resolveDataDir(), LEGACY_INGRESS_DIR, "state.json");
}

export function readAppServerState(): AppServerState | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(appServerStatePath(), "utf-8"));
  } catch {
    // The renamed dir has no record yet; a pre-rename install's record
    // still tells the truth about a running pre-rename server.
    if (!existsSync(appServerStatePath()) && existsSync(legacyStatePath())) {
      try {
        raw = JSON.parse(readFileSync(legacyStatePath(), "utf-8"));
      } catch {
        return null;
      }
    } else {
      return null;
    }
  }
  const state = (raw ?? {}) as Record<string, unknown>;
  const listenPort = state.listenPort;
  if (typeof listenPort !== "number") return null;
  const gatewayUrl = state.gatewayUrl;
  const remoteWebConfigHash = state.remoteWebConfigHash;
  const serve = state.serve as AppServerState["serve"] | undefined;
  return {
    listenPort,
    ...(typeof gatewayUrl === "string" ? { gatewayUrl } : {}),
    ...(typeof remoteWebConfigHash === "string" ? { remoteWebConfigHash } : {}),
    ...(serve && typeof serve === "object" ? { serve } : {}),
  };
}

function clearStoppedAppServer(pidPath: string): void {
  rmSync(appServerStatePath(), { force: true });
  rmSync(pidPath, { force: true });
  // The app server is gone; release the root lockfile's process entry with
  // it. Its built-sha stamp survives (a build-cache fact, not a process
  // fact) so restarting never pays a needless bundle rebuild.
  clearAppProcessRecord();
}

const STOP_TIMEOUT_MS = 2_000;

async function waitForPidExit(
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !isPidAlive(pid);
}

/**
 * Stop the running app server via its pidfile and clear the recorded state.
 * Returns true if a process was stopped.
 *
 * Verifies the PID still belongs to this app server before killing to avoid
 * hitting an unrelated process if the OS has reused the PID. SIGTERM first;
 * escalate to SIGKILL if it doesn't exit within the timeout.
 */
export async function stopAppServer(): Promise<boolean> {
  const paths = getAppServerPaths();

  const pid = readPidFile(paths.pidPath);
  if (pid === null || !isPidAlive(pid) || !isAppServerProcess(pid, paths)) {
    clearStoppedAppServer(paths.pidPath);
    return false;
  }

  try {
    process.kill(pid, "SIGTERM");
    if (!(await waitForPidExit(pid, STOP_TIMEOUT_MS))) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        if (!isPidAlive(pid)) {
          clearStoppedAppServer(paths.pidPath);
          return true;
        }
        return false;
      }
      if (!(await waitForPidExit(pid, STOP_TIMEOUT_MS))) {
        return false;
      }
    }
  } catch {
    if (!isPidAlive(pid)) {
      clearStoppedAppServer(paths.pidPath);
      return true;
    }
    return false;
  }

  clearStoppedAppServer(paths.pidPath);
  return true;
}

/** Container topologies whose gateway runs on this machine without host `resources`. */
function isLocalContainerEntry(entry: LockfileAssistant): boolean {
  return entry.cloud === "docker" || entry.cloud === "apple-container";
}

/**
 * Stop the app server when it is fronting THIS entry's gateway: a no-op for
 * non-container topologies, when no app server runs, or when the running
 * server's recorded upstream is a different assistant's gateway.
 */
export async function stopContainerAppServer(
  entry: LockfileAssistant,
): Promise<boolean> {
  if (!isLocalContainerEntry(entry)) {
    return false;
  }
  if (!isAppServerRunning()) {
    return false;
  }
  if (readAppServerState()?.gatewayUrl !== getGatewayUrl(entry)) {
    return false;
  }
  return stopAppServer();
}
