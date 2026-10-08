import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Resolve the Cadet root directory.
 *
 * Resolution order:
 * 1. Parent of CADET_WORKSPACE_DIR — e.g.
 *    .../assistants/<name>/workspace → .../assistants/<name>
 * 2. If that parent is "/" (workspace at top level, e.g. /workspace), fall
 *    back to the env-scoped XDG data root
 *    (`$XDG_DATA_HOME/cadet[-<env>]`).
 *
 * This replaces the old inlined `getRootDir()` pattern used by individual migrations.
 */
export function getCadetRoot(): string {
  const workspaceDir = process.env.CADET_WORKSPACE_DIR?.trim();
  if (workspaceDir) {
    const parent = dirname(workspaceDir);
    if (parent !== "/") {
      return parent;
    }
  }
  const dataHome =
    process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share");
  const rawEnv = process.env.CADET_ENVIRONMENT?.trim();
  const dirName = !rawEnv || rawEnv === "production" ? "cadet" : `cadet-${rawEnv}`;
  return join(dataHome, dirName);
}
