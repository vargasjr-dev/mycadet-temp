import { renameSync, rmSync, writeFileSync } from "node:fs";

/**
 * Write a file atomically: pid-unique temp beside the target, rename over
 * it; a finally sweep stops a failed write from littering the temp.
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
