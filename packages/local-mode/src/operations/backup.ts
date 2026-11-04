import type { LockfileAssistant } from "../lockfile-contract";
import { isCloudEntry } from "../lockfile-contract";
import { cliCommand } from "../environment";
import { readCloudToken } from "../cloud-auth";
import { getBackupsDir } from "../backup-ops";
import { createRootBackup } from "../root-backup";
import { createCloudBackup } from "../cloud-backup";
import { join } from "node:path";

/**
 * The backup OPERATION: the headless core of `cadet backup`, structured like
 * the wake/sleep/hatch operations. A cloud entry's roots live on the cloud —
 * the leg requests a managed snapshot with the stored session token and
 * waits until it is restorable; a local or docker entry's roots live on this
 * machine — the leg captures them all under the root-operation lock. Every
 * other topology runs on its own host and refuses here.
 *
 * Never throws and never exits the process — failures come back structured
 * so the command layer maps them onto the CLI's error taxonomy.
 */
export type BackupAssistantResult =
  | { ok: true; kind: "cloud" }
  | { ok: true; kind: "roots"; path: string }
  | { ok: false; status: number; error: string };

export async function backupAssistant(
  entry: LockfileAssistant,
): Promise<BackupAssistantResult> {
  if (isCloudEntry(entry)) {
    const token = readCloudToken();
    if (!token) {
      return {
        ok: false,
        status: 401,
        error: `Not logged in. Run '${cliCommand()} login' first.`,
      };
    }
    await createCloudBackup(entry, token);
    return { ok: true, kind: "cloud" };
  }
  if (!isLocalOrDockerEntry(entry)) {
    return {
      ok: false,
      status: 400,
      error: `Backup for '${entry.cloud}' must run on its host; only local, Docker and cloud backups are supported.`,
    };
  }
  const path = join(
    getBackupsDir(),
    `${entry.assistantId}-${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz`,
  );
  await createRootBackup(entry, path);
  return { ok: true, kind: "roots", path };
}

function isLocalOrDockerEntry(
  entry: LockfileAssistant,
): entry is LockfileAssistant & { cloud: "local" | "docker" } {
  return entry.cloud === "local" || entry.cloud === "docker";
}
