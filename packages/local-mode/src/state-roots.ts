import { lstat, readdir, rm } from "node:fs/promises";
import { posix, join } from "node:path";
import * as tar from "tar";

/** The persistent service roots every topology backs up and restores. */
export const STATE_ROOTS = [
  "workspace",
  "gateway-security",
  "ces-security",
  "ces-data",
] as const;
export type StateRoot = (typeof STATE_ROOTS)[number];

/**
 * What counts as worth capturing: regular files, directories and symlinks.
 * Sockets and other process artifacts never read as persistent; runtime
 * file hygiene belongs to the harness side, not this layer.
 */
export function persistent(
  path: string,
  stat: import("node:fs").Stats | tar.ReadEntry,
): boolean {
  return "isFile" in stat
    ? stat.isFile() || stat.isDirectory() || stat.isSymbolicLink()
    : ["File", "Directory", "SymbolicLink", "Link"].includes(stat.type);
}

/** Remove non-regular entries (sockets, fifos) a docker-cp tar may carry. */
export async function pruneTransient(root: string, relative = ""): Promise<void> {
  for (const name of await readdir(join(root, relative))) {
    const path = posix.join(relative, name);
    const stat = await lstat(join(root, path));
    if (!persistent(path, stat))
      await rm(join(root, path), { recursive: true, force: true });
    else if (stat.isDirectory()) await pruneTransient(root, path);
  }
}
