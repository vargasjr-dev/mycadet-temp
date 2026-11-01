import { join } from "node:path";

import { resolveDataDir } from "../../config";
import type { LockfileAssistant } from "../../lockfile-contract";

/**
 * The local topology's on-disk geography: the instance's data root and the
 * daemon PID file inside it. Re-exported by the CLI's `remotes/local.ts` for
 * its remaining consumers.
 */

/**
 * The instance's data root: the recorded instanceDir, or the shared state
 * root for legacy entries predating per-instance dirs.
 */
export function getLocalInstanceDir(
  entry?: LockfileAssistant | undefined,
): string {
  return (
    (entry &&
    (entry.cloud === "local" ||
      entry.cloud === "docker" ||
      entry.cloud === "apple-container")
      ? entry.instanceDir
      : undefined) ?? resolveDataDir()
  );
}

/**
 * Derive the daemon PID file path from an entry. The PID file lives inside
 * the instance's workspace directory. Falls back to the XDG data root's
 * workspace when the entry carries no instance dir.
 */
export function getDaemonPidPath(
  entry?: LockfileAssistant | undefined,
): string {
  return join(getLocalInstanceDir(entry), "workspace", "cadet.pid");
}
