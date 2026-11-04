import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { exec } from "../../exec";
import { restoreRootBackup } from "../../root-backup";
import { saveLockfileAssistant } from "../../lockfile";
import { getArchivePath, getMetadataPath } from "./archive";
import { getLocalInstanceDir } from "./instance";
import { wakeAssistant } from "../../operations/wake";
import type { LockfileAssistant } from "../../lockfile-contract";

export type RestoreRootsResult =
  | { ok: true; dryRun: boolean; recoveryPath?: string }
  | { ok: false; status: number; error: string };

/**
 * The local restore leg: unpack a root archive back over the assistant's
 * on-machine state roots — the shared root-backup machinery's restore path,
 * with LocalRootStorage supplying the filesystem mechanics and the
 * root-operation lock. A dry run validates the archive and stops.
 *
 * Throws on failure; the operation maps it.
 */
export async function restoreRoots(
  entry: LockfileAssistant,
  opts: { fromPath: string; dryRun: boolean },
): Promise<RestoreRootsResult> {
  const recoveryPath = await restoreRootBackup(entry, opts.fromPath, {
    dryRun: opts.dryRun,
  });
  return { ok: true, dryRun: opts.dryRun, recoveryPath };
}

/**
 * Recover a previously retired local assistant from its archive: extract the
 * archived instance dir back to its original location, restore the lockfile
 * entry, and start the assistant and gateway. Archives live in
 * $XDG_DATA_HOME/cadet/retired/ (default: ~/.local/share/cadet/retired/).
 *
 * Retire archives local instances only — a non-local metadata entry is a
 * structured refusal. Failures before extraction refuse; failures after the
 * archive is unpacked throw (the lockfile entry and extraction are already
 * on disk, so a retry surfaces the owned-target refusal).
 */
export async function recoverRetired(
  name: string,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const archivePath = getArchivePath(name);
  const metadataPath = getMetadataPath(name);

  // Verify the archive exists
  if (!existsSync(archivePath) || !existsSync(metadataPath)) {
    return {
      ok: false,
      status: 404,
      error: `No retired archive found for '${name}'.`,
    };
  }

  // Read and validate metadata before any side effects
  let entry: LockfileAssistant;
  try {
    entry = JSON.parse(readFileSync(metadataPath, "utf-8"));
  } catch (err) {
    return {
      ok: false,
      status: 422,
      error: `Retired metadata for '${name}' is unreadable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  // Retire archives local instances, so only a local entry can be restored.
  if (entry.cloud !== "local") {
    return {
      ok: false,
      status: 400,
      error: `Retired assistant '${name}' is not a local assistant; only local archives can be restored.`,
    };
  }

  // Check that the recovering entry's own target directory is free.
  const target = getLocalInstanceDir(entry);
  if (existsSync(target)) {
    return {
      ok: false,
      status: 409,
      error:
        `${target} already exists (owned by ${entry.assistantId}). ` +
        `Retire the current assistant first.`,
    };
  }

  // Extract and rename.
  //
  // retireLocal archives the full instanceDir. The directory is staged under
  // `<archive>.staging` inside the retired dir before being packed with
  // `tar -C <retiredDir> <stagingBasename>`, so the top-level entry inside
  // the tarball is always `<name>.tar.gz.staging`.
  //
  // Correct restoration: extract to retiredDir, then rename the staging entry
  // back to the original target path. Using homedir() as the -C target was
  // wrong for any instance stored outside the home directory.
  const targetDir = getLocalInstanceDir(entry);
  const retiredDir = dirname(archivePath);
  const extractedPath = join(retiredDir, basename(archivePath) + ".staging");

  await exec("tar", ["xzf", archivePath, "-C", retiredDir]);
  mkdirSync(dirname(targetDir), { recursive: true });
  renameSync(extractedPath, targetDir);
  saveLockfileAssistant(entry);
  // wakeAssistant is the one revive seam: the local leg brings CES sibling,
  // daemon, and gateway up in parallel (the way the Docker topology starts
  // its sibling containers together) and self-heals anything already alive.
  await wakeAssistant(entry);

  unlinkSync(archivePath);
  unlinkSync(metadataPath);

  return { ok: true };
}
