import { join } from "node:path";

import { resolveInstanceDir } from "../../config";
import type { LocalAssistant } from "../../lockfile-contract";

/**
 * The local topology's on-disk geography: the instance's data root and the
 * daemon PID file inside it. Re-exported by the CLI's `remotes/local.ts` for
 * its remaining consumers.
 */

/**
 * The instance's data root: the recorded instanceDir, else the assistant's
 * own directory under the state root's assistants/ tree. Only local
 * assistants have one — the instance dir is a local-topology concept, so
 * this takes a LocalAssistant and nothing else.
 */
export function getLocalInstanceDir(entry: LocalAssistant): string {
  return entry.instanceDir ?? resolveInstanceDir(entry.assistantId);
}

/**
 * Derive the daemon PID file path from an entry. The PID file lives inside
 * the instance's workspace directory.
 */
export function getDaemonPidPath(entry: LocalAssistant): string {
  return join(getLocalInstanceDir(entry), "workspace", "cadet.pid");
}
