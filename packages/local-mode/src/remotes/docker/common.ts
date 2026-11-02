import { join } from "node:path";

import { exec } from "../../exec";

/** Directory for user-local binary installs (no sudo required). */
export const LOCAL_BIN_DIR = join(
  process.env.HOME || process.env.USERPROFILE || ".",
  ".local",
  "bin",
);

const COLIMA_SETTLE_TIMEOUT_MS = 15_000;

export function ensureLocalBinOnPath(): void {
  const currentPath = process.env.PATH || "";
  if (!currentPath.includes(LOCAL_BIN_DIR)) {
    process.env.PATH = `${LOCAL_BIN_DIR}:${currentPath}`;
  }
}

/** Poll `docker info` until the daemon answers or the timeout elapses. */
async function waitForDockerDaemon(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await exec("docker", ["info"]);
      return true;
    } catch {
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

/**
 * Start Colima and wait for the Docker daemon to actually answer.
 *
 * `colima start` exiting 0 only means Colima's own state file says the VM is
 * up — that state can be stale (zombie VM after a host sleep or crash), in
 * which case start is a no-op ("already running, ignoring") while the daemon
 * inside stays dead. So success is decided by re-probing `docker info`, and a
 * failed probe triggers the manual-fix cycle: force-stop and start fresh.
 * Never `colima delete` — the VM disk holds every container image and volume.
 */
export async function startColimaAndAwaitDaemon(
  _log: (message: string) => void,
  opts: { startArgs?: string[]; settleTimeoutMs?: number } = {},
): Promise<void> {
  const startArgs = opts.startArgs ?? [];
  const settleTimeoutMs = opts.settleTimeoutMs ?? COLIMA_SETTLE_TIMEOUT_MS;
  try {
    await exec("colima", ["start", ...startArgs]);
  } catch (err) {
    // exec captures the child's output and only surfaces it in the error —
    // print it so a failed start is never silent.
    console.log(
      `⚠️  colima start failed: ${err instanceof Error ? err.message : err}`,
    );
  }

  if (await waitForDockerDaemon(settleTimeoutMs)) return;

  console.log(
    "🔄 Colima state looks stale — restarting the VM (colima stop --force, then start)...",
  );
  await exec("colima", ["stop", "--force"]).catch(() => {});
  try {
    await exec("colima", ["start", ...startArgs]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to restart Colima. Please run 'colima stop --force && colima start' manually.\n${message}`,
    );
  }
  if (!(await waitForDockerDaemon(settleTimeoutMs))) {
    throw new Error(
      "Docker daemon is still not reachable after restarting Colima. " +
        "Check `colima status` and `docker info`, then try again.",
    );
  }
}

/**
 * A reachable daemon — Docker Desktop, a running Colima, or any other active
 * context — is exactly what hatch used. Reuse it rather than forcing Colima.
 */
export async function ensureDockerDaemonRunning(
  opts: { settleTimeoutMs?: number } = {},
): Promise<void> {
  ensureLocalBinOnPath();

  try {
    await exec("docker", ["info"]);
    return;
  } catch {
    // No daemon reachable — fall through to the Colima fallback below.
  }

  // Deliberately no `colima status` probe: it trusts Colima's own state file,
  // which can be stale (zombie VM) — daemon reachability is the oracle.
  console.log("🚀 Docker daemon not running. Starting Colima...");
  await startColimaAndAwaitDaemon(console.log, opts);
}

/** The `docker start` failure for a container that was never created. */
export function isNoSuchContainerError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("No such container");
}
