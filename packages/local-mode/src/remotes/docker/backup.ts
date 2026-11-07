import { createRootBackup, newRootBackupPath } from "../../root-backup";
import type { LockfileAssistant } from "../../lockfile-contract";

/**
 * The docker backup LEG: pack the docker assistant's persistent state roots
 * (volumes inside the service containers) into a fresh archive under the
 * backups dir. The capture rides the root-operation lock and the sleep/wake
 * cycle around the pack — the shared root-backup machinery — with
 * DockerRootStorage supplying the `docker cp` mechanics; a host path can
 * never recurse into a volume, so no target-safety rule applies.
 *
 * Throws on failure; the operation maps it.
 */
export async function backupDocker(entry: LockfileAssistant): Promise<string> {
  const path = newRootBackupPath(entry);
  await createRootBackup(entry, path);
  return path;
}
