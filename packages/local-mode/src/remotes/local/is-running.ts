import { join } from "node:path";
import type { DockerAssistant, LocalAssistant } from "../../lockfile-contract";
import { probePort } from "../../ports";
import { isProcessAlive } from "../../process";
import { getDaemonPidPath, getLocalInstanceDir } from "./instance";

/**
 * Whether any of an on-machine instance's services (assistant daemon,
 * gateway, content-editor) are alive right now. A service counts as running
 * only with a live PID file; a port occupied without one refuses the check
 * instead of quietly reporting "not running" while something unrecorded
 * still holds the port.
 */
export async function isRunningLocal(
  entry: LocalAssistant | DockerAssistant,
): Promise<boolean> {
  const root = getLocalInstanceDir(entry);
  const running = new Set(
    [
      ["assistant", getDaemonPidPath(entry)],
      ["gateway", join(root, "gateway.pid")],
      ["ces", join(root, "ces.pid")],
    ]
      .filter(([, file]) => isProcessAlive(file!).alive)
      .map(([service]) => service!),
  );
  for (const [service, port] of [
    ["assistant", entry.daemonPort],
    ["gateway", entry.port],
    ["ces", entry.cesPort],
  ] as const) {
    if (
      !running.has(service) &&
      port !== undefined &&
      (await probePort(port))
    ) {
      throw new Error(
        `${service} port ${port} is occupied without a live PID file; stop that service before backup/restore.`,
      );
    }
  }
  return running.size > 0;
}
