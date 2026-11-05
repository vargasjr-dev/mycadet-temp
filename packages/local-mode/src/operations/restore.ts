import type { LockfileAssistant } from "../lockfile-contract";
import { cliCommand } from "../environment";
import {
  restoreCloud,
  type CloudRestoreImport,
  type CloudRestorePreflight,
} from "../remotes/cloud/restore";
import { recoverRetired, restoreLocal } from "../remotes/local/restore";
import { restoreDocker } from "../remotes/docker/restore";

export type {
  CloudRestoreImport,
  CloudRestorePreflight,
} from "../remotes/cloud/restore";

/**
 * The restore OPERATION: the headless core of `cadet restore`, structured
 * like the wake/sleep/backup operations — a remote -> method router over the
 * entry's topology. The cloud leg pushes the root archive through the
 * cloud's migration API (signed-URL upload, preflight-or-import, job poll);
 * the local and docker legs unpack it over the machine's state roots under
 * the root-operation lock. Every other topology runs on its own host and
 * refuses here.
 *
 * One door for both scopes: with a `fromPath` the archive restores into the
 * given entry; without one the named retired assistant recovers from its
 * archive in $XDG_DATA_HOME/cadet/retired/ (the recoverAssistant arm).
 *
 * Never throws and never exits the process — failures come back structured
 * so the command layer maps them onto the CLI's error taxonomy.
 */
export type RestoreAssistantResult =
  | { ok: true; kind: "recovery" }
  | { ok: true; kind: "cloud"; dryRun: true; preflight: CloudRestorePreflight }
  | { ok: true; kind: "cloud"; dryRun: false; import: CloudRestoreImport }
  | { ok: true; kind: "roots"; dryRun: boolean; recoveryPath?: string }
  | { ok: false; status: number; error: string };

export interface RestoreAssistantOptions {
  /** The retired assistant's name — the recovery arm's target. */
  name?: string;
  /** The entry to restore the archive into — requires fromPath. */
  entry?: LockfileAssistant;
  /** Path to the .tar.gz root archive; absent recovers a retired assistant. */
  fromPath?: string;
  /** Validate and report without applying (restores only). */
  dryRun?: boolean;
  /** Progress narration for the long cloud import (headless hosts omit it). */
  log?: (line: string) => void;
}

export async function restoreAssistant(
  opts: RestoreAssistantOptions,
): Promise<RestoreAssistantResult> {
  if (!opts.fromPath) {
    if (!opts.name) {
      throw new TypeError(
        "restoreAssistant requires a name or an entry with fromPath",
      );
    }
    return recoverAssistant(opts.name);
  }
  if (!opts.entry) {
    throw new TypeError("restoreAssistant requires an entry with fromPath");
  }
  const dryRun = opts.dryRun ?? false;
  switch (opts.entry.cloud) {
    case "cloud": {
      const result = await restoreCloud(opts.entry, {
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
      const result = await restoreLocal(opts.entry, {
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
      const result = await restoreDocker(opts.entry, {
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
        error: `'${cliCommand()} restore' is unsupported for a ${opts.entry.cloud} assistant.`,
      };
  }
}

/**
 * The recover arm: revive a retired local assistant from its archive in
 * $XDG_DATA_HOME/cadet/retired/ — extraction, lockfile restore, and the
 * wake. Retire archives local instances only.
 */
async function recoverAssistant(name: string): Promise<RestoreAssistantResult> {
  const result = await recoverRetired(name);
  return result.ok ? { ok: true, kind: "recovery" } : result;
}
