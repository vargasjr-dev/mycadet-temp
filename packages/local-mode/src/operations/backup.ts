import type { LockfileAssistant } from "../lockfile-contract";
import { cliCommand } from "../environment";
import { backupCloud } from "../remotes/cloud/backup";
import { backupLocal } from "../remotes/local/backup";
import { backupDocker } from "../remotes/docker/backup";

/**
 * The backup OPERATION: the headless core of `cadet backup`, structured like
 * the wake/sleep/hatch operations — a remote -> method router over the
 * entry's topology. The cloud leg requests a managed snapshot of the roots
 * the cloud holds and waits until it is restorable; the local and docker
 * legs capture the on-machine roots under the root-operation lock. Every
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
  switch (entry.cloud) {
    case "cloud": {
      const result = await backupCloud(entry);
      return result.ok ? { ok: true, kind: "cloud" } : result;
    }
    case "local":
      return { ok: true, kind: "roots", path: await backupLocal(entry) };
    case "docker":
      return { ok: true, kind: "roots", path: await backupDocker(entry) };
    default:
      return {
        ok: false,
        status: 400,
        error: `Backup for '${entry.cloud}' must run on its host; only local, Docker and cloud backups are supported.`,
      };
  }
}
