/**
 * Replays an existing .import-marker.json before the database opens. A pending
 * workspace swap can leave live data in .import-* or .pre-import-* directories;
 * recovery restores an incomplete swap or cleans up a completed one. This module
 * only consumes the on-disk journal, without reading or converting archives.
 */
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  unlink,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import { z } from "zod";

import { getLogger } from "../util/logger.js";
const log = getLogger("interrupted-import-recovery");
interface CarriedPath {
  liveChild: string;

  tempChild: string;
}

async function restoreCarriedPaths(
  carried: readonly CarriedPath[],
): Promise<number> {
  let failedCount = 0;
  for (const { liveChild, tempChild } of carried) {
    try {
      await mkdir(dirname(liveChild), { recursive: true });
      await rename(tempChild, liveChild);
    } catch (err) {
      if (isEXDEV(err)) {
        try {
          await copyTreeSkippingTransient(tempChild, liveChild);
          await rm(tempChild, { recursive: true, force: true });
          continue;
        } catch (cpErr) {
          failedCount += 1;
          log.error(
            { err: cpErr, liveChild, tempChild },
            "Failed to restore carried preserved path via cp fallback; manual recovery may be required",
          );
          continue;
        }
      }
      if (isENOENT(err)) {
        continue;
      }
      failedCount += 1;
      log.error(
        { err, liveChild, tempChild },
        "Failed to restore carried preserved path; manual recovery may be required",
      );
    }
  }
  return failedCount;
}

async function copyTreeSkippingTransient(
  src: string,
  dst: string,
): Promise<void> {
  try {
    await cp(src, dst, {
      recursive: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
      filter: async (source) => {
        try {
          const info = await lstat(source);
          return info.isFile() || info.isDirectory() || info.isSymbolicLink();
        } catch {
          return true;
        }
      },
    });
  } catch (err) {
    if (!isCpUnsupportedFileType(err)) {
      throw err;
    }
    log.warn(
      { err, src, dst },
      "cp filter still surfaced unsupported file type; falling back to manual walk",
    );
    await manualCopyTreeSkippingTransient(src, dst);
  }
}

const FsErrorSchema = z.object({ code: z.string() });
function errorCode(err: unknown): string | undefined {
  const parsed = FsErrorSchema.safeParse(err);
  return parsed.success ? parsed.data.code : undefined;
}
function isCpUnsupportedFileType(err: unknown): boolean {
  return [
    "ERR_FS_CP_SOCKET",
    "ERR_FS_CP_FIFO_PIPE",
    "ERR_FS_CP_UNKNOWN",
  ].includes(errorCode(err) ?? "");
}

async function manualCopyTreeSkippingTransient(
  src: string,
  dst: string,
): Promise<void> {
  const info = await lstat(src);
  if (info.isSymbolicLink()) {
    const target = await readlink(src);
    await mkdir(dirname(dst), { recursive: true });
    await rm(dst, { force: true }).catch(() => {
      /* best effort — a subsequent symlink error will surface any real issue */
    });
    await symlink(target, dst);
    return;
  }
  if (info.isFile()) {
    await mkdir(dirname(dst), { recursive: true });
    await copyFile(src, dst);
    return;
  }
  if (info.isDirectory()) {
    await mkdir(dst, { recursive: true });
    for (const name of await readdir(src)) {
      await manualCopyTreeSkippingTransient(join(src, name), join(dst, name));
    }
    return;
  }
  log.debug(
    { src },
    "Skipping transient/special filesystem entry during cross-fs copy",
  );
}

interface RestoreFromBackupResult {
  ok: boolean;

  failedCount: number;
}

async function restoreFromBackupDir(
  backupDir: string,
  realWorkspaceDir: string,
  carried: readonly CarriedPath[],
): Promise<RestoreFromBackupResult> {
  let backupEntries: string[];
  try {
    backupEntries = await readdir(backupDir);
  } catch (err) {
    if (isENOENT(err)) {
      return { ok: true, failedCount: 0 };
    }
    log.error(
      { err, backupDir },
      "Failed to read backup dir during restore; skipping backup restoration",
    );
    return { ok: false, failedCount: 1 };
  }

  const carriedLivePaths = carried.map((c) => resolve(c.liveChild));

  let failedCount = 0;

  for (const name of backupEntries) {
    const src = join(backupDir, name);
    const dst = join(realWorkspaceDir, name);
    const dstAbs = resolve(dst);

    const hasProtectedDescendant = carriedLivePaths.some((carriedAbs) => {
      if (carriedAbs === dstAbs) {
        return false;
      }
      return carriedAbs.startsWith(dstAbs + sep);
    });

    if (hasProtectedDescendant) {
      try {
        await mergeBackupIntoLive(src, dst, carriedLivePaths);
      } catch (err) {
        failedCount += 1;
        log.error(
          { err, src, dst },
          "Failed to merge backup subtree into live workspace during restore",
        );
      }
      continue;
    }

    try {
      await rm(dst, { recursive: true, force: true });
    } catch (err) {
      log.warn(
        { err, dst },
        "Failed to clear partial-swap entry before restoring from backup",
      );
    }
    try {
      await rename(src, dst);
    } catch (err) {
      if (isEXDEV(err)) {
        try {
          await copyTreeSkippingTransient(src, dst);
          await rm(src, { recursive: true, force: true });
          continue;
        } catch (cpErr) {
          failedCount += 1;
          log.error(
            { err: cpErr, src, dst },
            "Failed to restore backup entry via cp fallback; manual recovery may be required",
          );
          continue;
        }
      }
      failedCount += 1;
      log.error(
        { err, src, dst },
        "Failed to restore backup entry; manual recovery may be required",
      );
    }
  }

  return { ok: failedCount === 0, failedCount };
}

async function mergeBackupIntoLive(
  src: string,
  dst: string,
  carriedLivePaths: readonly string[],
): Promise<void> {
  await mkdir(dst, { recursive: true });

  let children: string[];
  try {
    children = await readdir(src);
  } catch (err) {
    if (isENOENT(err)) {
      return;
    }
    throw err;
  }

  for (const childName of children) {
    const childSrc = join(src, childName);
    const childDst = join(dst, childName);
    const childDstAbs = resolve(childDst);

    let dstExists = false;
    try {
      await stat(childDst);
      dstExists = true;
    } catch (err) {
      if (!isENOENT(err)) {
        throw err;
      }
    }

    if (!dstExists) {
      try {
        await rename(childSrc, childDst);
      } catch (err) {
        if (isEXDEV(err)) {
          await copyTreeSkippingTransient(childSrc, childDst);
          await rm(childSrc, { recursive: true, force: true });
        } else {
          throw err;
        }
      }
      continue;
    }

    const isCarriedLeaf = carriedLivePaths.includes(childDstAbs);
    if (isCarriedLeaf) {
      continue;
    }
    const containsCarried = carriedLivePaths.some(
      (c) => c !== childDstAbs && c.startsWith(childDstAbs + sep),
    );
    if (containsCarried) {
      await mergeBackupIntoLive(childSrc, childDst, carriedLivePaths);
      continue;
    }

    await rm(childDst, { recursive: true, force: true });
    try {
      await rename(childSrc, childDst);
    } catch (err) {
      if (isEXDEV(err)) {
        await copyTreeSkippingTransient(childSrc, childDst);
        await rm(childSrc, { recursive: true, force: true });
      } else {
        throw err;
      }
    }
  }
}

function isENOENT(err: unknown): boolean {
  return errorCode(err) === "ENOENT";
}
function isEXDEV(err: unknown): boolean {
  return errorCode(err) === "EXDEV";
}

const ImportMarkerSchema = z.object({
  tempWorkspaceDir: z.string(),

  carried: z.array(z.object({ liveChild: z.string(), tempChild: z.string() })),

  backupDir: z.string().optional(),

  swapCompleted: z.boolean().optional(),
});

const IMPORT_MARKER_BASENAME = ".import-marker.json";
function importMarkerPathFor(root: string): string {
  return join(root, IMPORT_MARKER_BASENAME);
}
async function safelyDeleteMarker(markerPath: string): Promise<void> {
  try {
    await unlink(markerPath);
  } catch (err) {
    if (isENOENT(err)) {
      return;
    }
    log.warn({ err, markerPath }, "Failed to delete import-recovery marker");
  }
}

export interface RecoveryResult {
  ok: boolean;

  failedCount: number;
}

export async function recoverInterruptedImport(
  realWorkspaceDir: string,
): Promise<RecoveryResult> {
  const markerPath = importMarkerPathFor(resolve(realWorkspaceDir));
  let raw: string;
  try {
    raw = await readFile(markerPath, "utf8");
  } catch (err) {
    if (isENOENT(err)) {
      return { ok: true, failedCount: 0 };
    }
    log.warn({ err, markerPath }, "Unable to read import-recovery marker");
    return { ok: true, failedCount: 0 };
  }

  let rawJson: unknown;
  try {
    rawJson = JSON.parse(raw);
  } catch (err) {
    log.warn(
      { err, markerPath },
      "Import-recovery marker is malformed; deleting without acting on it",
    );
    await safelyDeleteMarker(markerPath);
    return { ok: true, failedCount: 0 };
  }

  const parsed = ImportMarkerSchema.safeParse(rawJson);
  if (!parsed.success) {
    log.warn(
      { markerPath, error: parsed.error.message },
      "Import-recovery marker has unexpected shape; deleting",
    );
    await safelyDeleteMarker(markerPath);
    return { ok: true, failedCount: 0 };
  }
  const marker = parsed.data;

  log.info(
    {
      markerPath,
      tempWorkspaceDir: marker.tempWorkspaceDir,
      carriedCount: marker.carried.length,
      swapCompleted: marker.swapCompleted === true,
    },
    "Recovering from interrupted import",
  );

  const carriedEntries = marker.carried.map((c) => ({
    liveChild: c.liveChild,
    tempChild: c.tempChild,
  }));

  if (marker.swapCompleted === true) {
    if (typeof marker.backupDir === "string" && marker.backupDir.length > 0) {
      await rm(marker.backupDir, { recursive: true, force: true }).catch(
        (err) => {
          log.warn(
            { err, backupDir: marker.backupDir },
            "Failed to clean up backup dir after completed import",
          );
        },
      );
    }
    await rm(marker.tempWorkspaceDir, { recursive: true, force: true }).catch(
      (err) => {
        log.warn(
          { err, tempWorkspaceDir: marker.tempWorkspaceDir },
          "Failed to clean up temp workspace after completed import",
        );
      },
    );
    await safelyDeleteMarker(markerPath);
    return { ok: true, failedCount: 0 };
  }

  let restoreResult: RestoreFromBackupResult = { ok: true, failedCount: 0 };
  if (typeof marker.backupDir === "string" && marker.backupDir.length > 0) {
    try {
      restoreResult = await restoreFromBackupDir(
        marker.backupDir,
        resolve(realWorkspaceDir),
        carriedEntries,
      );
    } catch (err) {
      log.error(
        { err, backupDir: marker.backupDir },
        "Failed to restore from backup dir during import recovery; manual intervention may be required",
      );
      restoreResult = { ok: false, failedCount: 1 };
    }
  }

  const carriedFailures = await restoreCarriedPaths(carriedEntries);
  restoreResult.failedCount += carriedFailures;
  restoreResult.ok = restoreResult.failedCount === 0;

  if (
    restoreResult.ok &&
    typeof marker.backupDir === "string" &&
    marker.backupDir.length > 0
  ) {
    await rm(marker.backupDir, { recursive: true, force: true }).catch(
      (err) => {
        log.warn(
          { err, backupDir: marker.backupDir },
          "Failed to clean up backup dir during import recovery",
        );
      },
    );
  } else if (!restoreResult.ok) {
    log.error(
      {
        backupDir: marker.backupDir,
        failedCount: restoreResult.failedCount,
      },
      "Backup restore had failures; preserving backup dir and marker for next-boot retry",
    );
  }

  if (restoreResult.ok) {
    try {
      await rm(marker.tempWorkspaceDir, { recursive: true, force: true });
    } catch (err) {
      log.warn(
        { err, tempWorkspaceDir: marker.tempWorkspaceDir },
        "Failed to clean up temp workspace during import recovery",
      );
    }
    await safelyDeleteMarker(markerPath);
  } else {
    log.warn(
      {
        tempWorkspaceDir: marker.tempWorkspaceDir,
        markerPath,
      },
      "Preserving temp tree + marker for next-boot recovery retry",
    );
  }

  return restoreResult.ok
    ? { ok: true, failedCount: 0 }
    : { ok: false, failedCount: restoreResult.failedCount };
}
