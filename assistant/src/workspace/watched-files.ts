import { join } from "node:path";

import { WORKSPACE_THEME_RELATIVE_PATH } from "../theme/workspace-theme.js";
import { WORKSPACE_MCP_FILENAME } from "../util/layout.js";

/**
 * Workspace files the daemon reloads while it runs, keyed by path relative to
 * the workspace.
 *
 * `protected` marks the files whose contents decide what the daemon starts or
 * where it sends traffic. The risk classifier rates a write to one of them
 * high, the same as a write to tools/ or hooks/. The config watcher's handler
 * map is typed on these keys, so a new reloaded file can't be added without
 * deciding here whether it's protected.
 */
export const WATCHED_WORKSPACE_FILES = {
  // Settings, including the URLs the gateway sends traffic to.
  "config.json": { protected: true },
  // Each MCP server entry names a command the daemon starts.
  [WORKSPACE_MCP_FILENAME]: { protected: true },
  // The assistant edits its own persona and theme.
  "SOUL.md": { protected: false },
  "IDENTITY.md": { protected: false },
  [WORKSPACE_THEME_RELATIVE_PATH]: { protected: false },
} as const;

export type WatchedWorkspaceFile = keyof typeof WATCHED_WORKSPACE_FILES;

/** Absolute paths of the watched files a write must not slip past. */
export function getProtectedWorkspaceFiles(workspaceDir: string): string[] {
  return Object.entries(WATCHED_WORKSPACE_FILES)
    .filter(([, file]) => file.protected)
    .map(([relativePath]) => join(workspaceDir, relativePath));
}
