import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { clearAppProcessRecord } from "./operations/lookup";
import { resolveDataDir, resolveLogDir } from "./config";
import type { LockfileAssistant } from "./lockfile-contract";
import { getGatewayUrl } from "./lockfile-contract";

/**
 * The machine-level nginx ingress edge's read/stop surface — the piece of
 * the CLI's `servers/nginx.ts` the lifecycle operations share. The edge is
 * machine-level (it fronts the active assistant's gateway for every tunnel
 * and wake path) and its state lives under the environment's XDG data dir,
 * never inside an assistant's workspace; the START paths remain the CLI's
 * for now and re-export these readers.
 */

export interface IngressPaths {
  /** nginx prefix dir; conf, pidfile, and temp dirs live here. */
  dir: string;
  confPath: string;
  pidPath: string;
  logPath: string;
}

export function getIngressPaths(): IngressPaths {
  const dir = join(resolveDataDir(), "ingress");
  return {
    dir,
    confPath: join(dir, "nginx.conf"),
    pidPath: join(dir, "nginx.pid"),
    logPath: join(resolveLogDir(), "nginx-ingress.log"),
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
 * Check whether a PID belongs to this ingress nginx process.
 *
 * Matching only the executable name is not enough: a stale pidfile can point
 * at a system nginx or another assistant's ingress after PID reuse.
 */
function isIngressNginxProcess(pid: number, paths: IngressPaths): boolean {
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
    return (
      /nginx/.test(output) &&
      output.includes(paths.dir) &&
      output.includes(paths.confPath)
    );
  } catch {
    return false;
  }
}

/** The ingress nginx PID when it is recorded and alive, null otherwise. */
export function getIngressPid(): number | null {
  const paths = getIngressPaths();
  const pid = readPidFile(paths.pidPath);
  return pid !== null && isPidAlive(pid) && isIngressNginxProcess(pid, paths)
    ? pid
    : null;
}

export function isIngressRunning(): boolean {
  return getIngressPid() !== null;
}

export interface IngressState {
  listenPort: number;
  /**
   * Gateway URL the edge's proxy_pass targets — `getGatewayUrl` of the entry
   * the edge fronts. Undefined in state records that predate the field;
   * callers treat an unknown upstream as unverified and restart the edge so
   * the running config provably targets the requested gateway and the state
   * is stamped for future comparisons.
   */
  gatewayUrl?: string;
  /**
   * Fingerprint of the injected SPA config and its source bundle. Undefined
   * for records that predate the field; an edge without a recorded
   * fingerprint is treated as drifted and restarted so the served index
   * provably carries the requested config.
   */
  remoteWebConfigHash?: string;
}

export function ingressStatePath(): string {
  return join(getIngressPaths().dir, "state.json");
}

export function readIngressState(): IngressState | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(ingressStatePath(), "utf-8"));
  } catch {
    return null;
  }
  const state = (raw ?? {}) as Record<string, unknown>;
  const listenPort = state.listenPort;
  if (typeof listenPort !== "number") return null;
  const gatewayUrl = state.gatewayUrl;
  const remoteWebConfigHash = state.remoteWebConfigHash;
  return {
    listenPort,
    ...(typeof gatewayUrl === "string" ? { gatewayUrl } : {}),
    ...(typeof remoteWebConfigHash === "string" ? { remoteWebConfigHash } : {}),
  };
}

function clearStoppedIngress(pidPath: string): void {
  rmSync(ingressStatePath(), { force: true });
  rmSync(pidPath, { force: true });
  // The edge is gone; release the root lockfile's process entry with it.
  // Its built-sha stamp survives (a build-cache fact, not a process fact)
  // so restarting the edge never pays a needless bundle rebuild.
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
 * Stop a running ingress nginx via its pidfile and clear the recorded state.
 * Returns true if a process was stopped.
 *
 * Verifies the PID still belongs to this ingress nginx before killing to avoid
 * hitting an unrelated process if the OS has reused the PID. SIGTERM is nginx
 * fast shutdown; escalate to SIGKILL if it doesn't exit within the timeout.
 */
export async function stopIngressNginx(): Promise<boolean> {
  const paths = getIngressPaths();

  const pid = readPidFile(paths.pidPath);
  if (pid === null || !isPidAlive(pid) || !isIngressNginxProcess(pid, paths)) {
    clearStoppedIngress(paths.pidPath);
    return false;
  }

  try {
    process.kill(pid, "SIGTERM");
    if (!(await waitForPidExit(pid, STOP_TIMEOUT_MS))) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        if (!isPidAlive(pid)) {
          clearStoppedIngress(paths.pidPath);
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
      clearStoppedIngress(paths.pidPath);
      return true;
    }
    return false;
  }

  clearStoppedIngress(paths.pidPath);
  return true;
}

/** Container topologies whose gateway runs on this machine without host `resources`. */
function isLocalContainerEntry(entry: LockfileAssistant): boolean {
  return entry.cloud === "docker" || entry.cloud === "apple-container";
}

/**
 * Stop the nginx edge when it is fronting THIS entry's gateway: a no-op for
 * non-container topologies, when no edge runs, or when the running edge's
 * recorded upstream is a different assistant's gateway.
 */
export async function stopContainerAppServer(
  entry: LockfileAssistant,
): Promise<boolean> {
  if (!isLocalContainerEntry(entry)) {
    return false;
  }
  if (!isIngressRunning()) {
    return false;
  }
  if (readIngressState()?.gatewayUrl !== getGatewayUrl(entry)) {
    return false;
  }
  return stopIngressNginx();
}
