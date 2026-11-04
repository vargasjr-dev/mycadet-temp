import type { LockfileAssistant } from "../lockfile-contract";
import { cliCommand } from "../environment";
import {
  restoreCloud,
  type CloudRestoreImport,
  type CloudRestorePreflight,
} from "../remotes/cloud/restore";
import {
  recoverRetired,
  restoreRoots as restoreLocalRoots,
} from "../remotes/local/restore";
import { restoreRoots as restoreDockerRoots } from "../remotes/docker/restore";

export type {
  CloudRestoreImport,
  CloudRestorePreflight,
} from "../remotes/cloud/restore";

/**
 * The restore OPERATION: the headless core of `cadet restore`, structured
 * like the wake/sleep/backup operations — a remote -> method router over the
 * entry's topology. The cloud leg pushes the root archive through the
 * platform's migration API (signed-URL upload, preflight-or-import, job
 * poll); the local and docker legs unpack it over the machine's state roots
 * under the root-operation lock. Every other topology runs on its own host
 * and refuses here.
 *
 * Never throws and never exits the process — failures come back structured
 * so the command layer maps them onto the CLI's error taxonomy.
 */
export type RestoreAssistantResult =
  | { ok: true; kind: "cloud"; dryRun: true; preflight: CloudRestorePreflight }
  | { ok: true; kind: "cloud"; dryRun: false; import: CloudRestoreImport }
  | { ok: true; kind: "roots"; dryRun: boolean; recoveryPath?: string }
  | { ok: false; status: number; error: string };

export interface RestoreAssistantOptions {
  /** Path to the .tar.gz root archive. */
  fromPath: string;
  /** Validate and report without applying (cloud: the platform preflight). */
  dryRun?: boolean;
  /** Progress narration for the long cloud import (headless hosts omit it). */
  log?: (line: string) => void;
}

export async function restoreAssistant(
  entry: LockfileAssistant,
  opts: RestoreAssistantOptions,
): Promise<RestoreAssistantResult> {
  const dryRun = opts.dryRun ?? false;
  switch (entry.cloud) {
    case "cloud": {
      const result = await restoreCloud(entry, {
        fromPath: opts.fromPath,
        dryRun,
        log: opts.log,
      });
      if (!result.ok) return result;
      return result.dryRun
        ? { ok: true, kind: "cloud", dryRun: true, preflight: result.preflight }
        : { ok: true, kind: "cloud", dryRun: false, import: result.import };
    }
    case "local": {
      const result = await restoreLocalRoots(entry, {
        fromPath: opts.fromPath,
        dryRun,
      });
      return result.ok
        ? {
            ok: true,
            kind: "roots",
            dryRun: result.dryRun,
            recoveryPath: result.recoveryPath,
          }
        : result;
    }
    case "docker": {
      const result = await restoreDockerRoots(entry, {
        fromPath: opts.fromPath,
        dryRun,
      });
      return result.ok
        ? {
            ok: true,
            kind: "roots",
            dryRun: result.dryRun,
            recoveryPath: result.recoveryPath,
          }
        : result;
    }
    default:
      return {
        ok: false,
        status: 400,
        error: `'${cliCommand()} restore' is unsupported for a ${entry.cloud} assistant.`,
      };
  }
}

export type RecoverRetiredResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

/**
 * The recover half of the restore operation: revive a retired local
 * assistant from its archive in $XDG_DATA_HOME/cadet/retired/ — extraction,
 * lockfile restore, and the wake. Retire archives local instances only.
 */
export async function recoverRetiredAssistant(
  name: string,
): Promise<RecoverRetiredResult> {
  return await recoverRetired(name);
}
