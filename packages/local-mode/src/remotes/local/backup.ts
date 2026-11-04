import { createRootBackup, newRootBackupPath } from "../../root-backup";
import type { LockfileAssistant } from "../../lockfile-contract";

/**
 * The local backup LEG: pack the on-machine persistent state roots (config,
 * workspace, daemon state) into a fresh archive under the backups dir. The
 * capture rides the root-operation lock and the sleep/wake cycle around the
 * pack — the shared root-backup machinery — with LocalRootStorage supplying
 * the filesystem mechanics and the save-outside-the-roots rule.
 *
 * Throws on failure; the operation maps it.
 */
export async function backupLocal(entry: LockfileAssistant): Promise<string> {
  const path = newRootBackupPath(entry);
  await createRootBackup(entry, path);
  return path;
}
