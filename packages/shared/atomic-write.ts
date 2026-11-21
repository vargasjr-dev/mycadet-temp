import { renameSync, rmSync, writeFileSync } from "node:fs";

/**
 * Write a file so readers never see it half-written: the contents land in a
 * pid-unique temp file beside the target, then rename over it. A crash
 * mid-write — or a concurrent reader — leaves the previous file intact, and
 * the finally sweep stops a failed write from littering the temp.
 *
 * The pid suffix keeps concurrent processes out of each other's temp file
 * while staying predictable enough for tests to park a directory at the
 * temp path and force a deterministic failure — the house technique for
 * exercising this contract with the real filesystem and no mocks. A hard
 * crash between write and rename leaves the temp behind, which is harmless:
 * the next writer at the same pid overwrites it, and no reader ever follows
 * the temp path.
 *
 * Single-threaded callers in one process cannot interleave: the writes are
 * synchronous.
 */
export function writeFileAtomic(
  targetPath: string,
  contents: string,
  options: { mode?: number } = {},
): void {
  const tempPath = `${targetPath}.tmp.${process.pid}`;
  try {
    writeFileSync(tempPath, contents, options);
    renameSync(tempPath, targetPath);
  } finally {
    rmSync(tempPath, { force: true });
  }
}
