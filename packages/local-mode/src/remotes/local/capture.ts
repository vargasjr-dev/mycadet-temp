import { cp, lstat, mkdir } from "node:fs/promises";
import { join, posix } from "node:path";

import { getLocalInstanceDir } from "./instance";
import { persistent, STATE_ROOTS } from "../../state-roots";
import type { LocalAssistant } from "../../lockfile-contract";

/**
 * The local topology's capture: copy each persistent state root off the
 * instance dir, keeping only what persists across sleeps.
 */
export async function captureLocalRoot(
  entry: LocalAssistant,
  target: string,
): Promise<void> {
  const root = getLocalInstanceDir(entry);
  await mkdir(target, { recursive: true, mode: 0o700 });
  for (const stateRoot of STATE_ROOTS) {
    const source = join(root, stateRoot);
    const stat = await lstat(source).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (!stat) throw new Error(`Persistent state root is missing: ${stateRoot}`);
    if (!stat.isDirectory())
      throw new Error(`State root must be a directory: ${stateRoot}`);
    await cp(source, join(target, stateRoot), {
      recursive: true,
      verbatimSymlinks: true,
      filter: async (path) =>
        persistent(
          posix.join(
            stateRoot,
            path
              .slice(source.length + 1)
              .split("\\")
              .join("/"),
          ),
          await lstat(path),
        ),
    });
  }
}
