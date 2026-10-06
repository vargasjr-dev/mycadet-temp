import { homedir } from "node:os";
import { dirname } from "node:path";

import { ensureCadetHomeAt } from "@vellumai/service-contracts/cadet-home";

import { getWorkspaceDirOverride } from "../../config/env-registry.js";

/**
 * Resolve the Cadet root directory (~/.cadet).
 *
 * Resolution order (mirrors util/platform.ts cadetRoot()):
 * 1. Parent of CADET_WORKSPACE_DIR/VELLUM_WORKSPACE_DIR — e.g. /data/.cadet/workspace → /data/.cadet
 * 2. If that parent is "/" (workspace at top level, e.g. /workspace), fall back
 *    to the Cadet home (~/.cadet). A legacy ~/.vellum is adopted via
 *    copy-not-move on first run; the legacy directory is left intact.
 *
 * This replaces the old inlined `getRootDir()` pattern used by individual migrations.
 */
export function getCadetRoot(): string {
  const workspaceDir = getWorkspaceDirOverride();
  if (workspaceDir) {
    const parent = dirname(workspaceDir);
    if (parent !== "/") {
      return parent;
    }
  }
  return ensureCadetHomeAt(homedir()).dir;
}
