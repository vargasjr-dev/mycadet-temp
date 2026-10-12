import { existsSync, unlinkSync } from "node:fs";

import { getWorkspacePromptPath } from "../util/layout.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("bootstrap-cleanup");

const BOOTSTRAP_FILES = ["BOOTSTRAP.md", "BOOTSTRAP-REFERENCE.md"] as const;

export function cleanupBootstrapFiles(reason: string): boolean {
  let deletedAny = false;

  for (const file of BOOTSTRAP_FILES) {
    const path = getWorkspacePromptPath(file);
    if (!existsSync(path)) {
      continue;
    }

    try {
      unlinkSync(path);
      deletedAny = true;
      log.info({ file, reason }, "Deleted bootstrap file");
    } catch (err) {
      log.warn({ err, file, reason }, "Failed to delete bootstrap file");
    }
  }

  return deletedAny;
}
