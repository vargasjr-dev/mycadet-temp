import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { LockfileAssistant } from "./assistant-config.js";
import { resolveDataDir } from "@mycadet/local-mode";

/**
 * Workspace-config helpers: where the machine-level default workspace lives
 * and how its `config.json` is read. The tunnel layer writes none of it —
 * tunnel state lives in the root lockfile's `tunnel` record.
 */

/** Container topologies whose gateway runs on this machine without host `resources`. */
export function isLocalContainerEntry(entry: LockfileAssistant): boolean {
  return entry.cloud === "docker" || entry.cloud === "apple-container";
}

/**
 * Default workspace dir: `$CADET_WORKSPACE_DIR` or the XDG data root's
 * workspace (`$XDG_DATA_HOME/cadet[-<env>]/workspace`).
 */
export function getDefaultWorkspaceDir(): string {
  return (
    process.env.CADET_WORKSPACE_DIR?.trim() ||
    join(resolveDataDir(), "workspace")
  );
}

function getConfigPath(workspaceDir: string): string {
  return join(workspaceDir, "config.json");
}

/** Read the workspace `config.json`, or an empty object when it is absent. */
export function loadRawConfig(workspaceDir: string): Record<string, unknown> {
  const configPath = getConfigPath(workspaceDir);
  if (!existsSync(configPath)) return {};
  return JSON.parse(readFileSync(configPath, "utf-8")) as Record<
    string,
    unknown
  >;
}

/** Write the workspace `config.json`, creating parent directories as needed. */
export function saveRawConfig(
  workspaceDir: string,
  config: Record<string, unknown>,
): void {
  const configPath = getConfigPath(workspaceDir);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
}
