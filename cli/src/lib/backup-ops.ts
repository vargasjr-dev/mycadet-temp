import { existsSync, readdirSync, statSync, unlinkSync } from "fs";
import { join } from "path";

import { findAssistantByName } from "./assistant-config.js";
import { createRootBackup, restoreRootBackup } from "./root-backup.js";
import { getStateDir } from "./environments/paths.js";
import { getCurrentEnvironment } from "./environments/resolve.js";

/** Default backup directory following XDG convention */
export function getBackupsDir(): string {
  return join(getStateDir(getCurrentEnvironment()), "backups");
}

/** Human-readable file size */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Internal safety backup callers resolve their registered host topology, never runtime auth. */
export async function createBackup(
  _runtimeUrl: string,
  assistantId: string,
  options?: { prefix?: string; description?: string; timeoutMs?: number },
): Promise<string | null> {
  try {
    const entry = findAssistantByName(assistantId);
    if (!entry)
      throw new Error(`No registered assistant found for '${assistantId}'.`);
    const prefix = options?.prefix ?? assistantId;
    if (prefix.includes("/") || prefix.includes("\\"))
      throw new Error("Backup prefix must be a filename.");
    const path = join(
      getBackupsDir(),
      `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz`,
    );
    await createRootBackup(entry, path);
    return path;
  } catch (error) {
    console.warn(
      `Backup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

/** Restore every persistent root; failed-state recovery can leave services stopped for its caller to restart. */
export async function restoreBackup(
  _runtimeUrl: string,
  assistantId: string,
  backupPath: string,
  options: { resume?: boolean } = {},
): Promise<boolean> {
  try {
    const entry = findAssistantByName(assistantId);
    if (!entry)
      throw new Error(`No registered assistant found for '${assistantId}'.`);
    await restoreRootBackup(entry, backupPath, options);
    return true;
  } catch (error) {
    console.warn(
      `Restore failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

/** Filename kinds this CLI writes: `<assistantId>-<kind>-<timestamp>.tar.gz`. */
export const CLI_BACKUP_KINDS = [
  "pre-upgrade",
  "pre-rollback",
  "pre-teleport",
] as const;
export type CliBackupKind = (typeof CLI_BACKUP_KINDS)[number];

/** `new Date().toISOString().replace(/[:.]/g, "-")`, as used in every CLI backup filename. */
const BACKUP_TIMESTAMP_PATTERN =
  "\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Matches the backup filenames this CLI wrote for exactly `assistantId` and
 * one of `kinds`. The kind and timestamp segments are matched in full, so an
 * assistant whose id is a prefix of another's (`alpha` vs `alpha-prod`, or
 * `alpha` vs `alpha-pre-teleport-prod`) never matches the other's files.
 */
export function assistantBackupFilenamePattern(
  assistantId: string,
  kinds: readonly CliBackupKind[] = CLI_BACKUP_KINDS,
): RegExp {
  return new RegExp(
    `^${escapeRegExp(assistantId)}-(?:${kinds.join("|")})-${BACKUP_TIMESTAMP_PATTERN}\\.tar\\.gz$`,
  );
}

/**
 * Modification times of the `.tar.gz` backups this CLI has written for
 * `assistantId` (every kind in `CLI_BACKUP_KINDS`), as ISO timestamps.
 * Missing directory yields `[]`.
 */
export function listAssistantBackupTimes(assistantId: string): string[] {
  const backupsDir = getBackupsDir();
  let names: string[];
  try {
    names = readdirSync(backupsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
  const pattern = assistantBackupFilenamePattern(assistantId);
  const times: string[] = [];
  for (const name of names) {
    if (!pattern.test(name)) {
      continue;
    }
    try {
      times.push(statSync(join(backupsDir, name)).mtime.toISOString());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
  }
  return times;
}

/**
 * Keep only the N most recent backups of one `kind` for an assistant,
 * deleting older ones. Filenames are matched exactly (id, kind and
 * timestamp), never by prefix. Default: keep 3 pre-upgrade backups.
 * Never throws — failures are silently ignored.
 */
export function pruneOldBackups(
  assistantId: string,
  keep: number = 3,
  kind: CliBackupKind = "pre-upgrade",
): void {
  try {
    const backupsDir = getBackupsDir();
    if (!existsSync(backupsDir)) return;

    const pattern = assistantBackupFilenamePattern(assistantId, [kind]);
    const entries = readdirSync(backupsDir)
      .filter((f) => pattern.test(f))
      .sort();

    if (entries.length <= keep) return;

    const toDelete = entries.slice(0, entries.length - keep);
    for (const file of toDelete) {
      try {
        unlinkSync(join(backupsDir, file));
      } catch {
        // Best-effort cleanup — ignore individual file errors
      }
    }
  } catch {
    // Best-effort cleanup — never block the upgrade
  }
}
