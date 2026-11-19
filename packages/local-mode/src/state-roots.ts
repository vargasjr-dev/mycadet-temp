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
 * Whether a workspace entry is a harness process artifact rather than
 * persistent state. Matched structurally — pid files and the harness's
 * live signal endpoint — so no harness file is pinned by name here.
 */
function isTransient(path: string): boolean {
  const [root, name] = path.split("/");
  return (
    root === "workspace" &&
    name !== undefined &&
    (name.endsWith(".pid") || name === "signals")
  );
}

export function persistent(
  path: string,
  stat: import("node:fs").Stats | tar.ReadEntry,
): boolean {
  return (
    !isTransient(path) &&
    ("isFile" in stat
      ? stat.isFile() || stat.isDirectory() || stat.isSymbolicLink()
      : ["File", "Directory", "SymbolicLink", "Link"].includes(stat.type))
  );
}

/** Remove process artifacts (sockets, pid files) a capture may have carried. */
export async function pruneTransient(root: string, relative = ""): Promise<void> {
  for (const name of await readdir(join(root, relative))) {
    const path = posix.join(relative, name);
    const stat = await lstat(join(root, path));
    if (!persistent(path, stat))
      await rm(join(root, path), { recursive: true, force: true });
    else if (stat.isDirectory()) await pruneTransient(root, path);
  }
}
