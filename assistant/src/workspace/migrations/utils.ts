import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Resolve the legacy Cadet root directory (~/.cadet).
 *
 * Resolution order:
 * 1. Parent of CADET_WORKSPACE_DIR — e.g. /data/.cadet/workspace → /data/.cadet
 * 2. If that parent is "/" (workspace at top level, e.g. /workspace), fall back
 *    to homedir()/.cadet
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
  return join(homedir(), ".cadet");
}
