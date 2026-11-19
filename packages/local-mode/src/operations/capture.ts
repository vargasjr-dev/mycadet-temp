import type { LockfileAssistant } from "../lockfile-contract";
import { captureLocalRoot } from "../remotes/local/capture";
import { captureDockerRoot } from "../remotes/docker/capture";

/**
 * The capture OPERATION: snapshot one assistant's persistent roots into a
 * staging dir, per-remote (the local leg copies the instance dir; the
 * docker leg `docker cp`s the volumes). Follows the other operations'
 * shape — one entry point that dispatches on the entry's cloud.
 */
export async function captureRoot(
  entry: LockfileAssistant,
  target: string,
): Promise<void> {
  if (entry.cloud === "docker") return captureDockerRoot(entry, target);
  if (entry.cloud === "local") return captureLocalRoot(entry, target);
  throw new Error(`Backup is unsupported for a ${entry.cloud} assistant.`);
}
