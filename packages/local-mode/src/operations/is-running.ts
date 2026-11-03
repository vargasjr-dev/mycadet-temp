import type { LockfileAssistant } from "../lockfile-contract";
import { isRunningDocker } from "../remotes/docker/is-running";
import { isRunningLocal } from "../remotes/local/is-running";

/**
 * Whether an assistant's host services are alive right now — the liveness
 * question the backup/restore/teleport lifecycles ask before they stop or
 * replace anything. Dispatches to the owning remote module; non-on-machine
 * assistants have no host services this question can be asked of.
 */
export async function isAssistantRunning(
  entry: LockfileAssistant,
): Promise<boolean> {
  if (entry.cloud === "docker") return isRunningDocker(entry);
  if (entry.cloud === "local") return isRunningLocal(entry);
  throw new Error(
    `Liveness is not tracked for '${entry.cloud}' assistants on this machine.`,
  );
}
