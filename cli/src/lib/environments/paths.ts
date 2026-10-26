import { homedir } from "node:os";
import { join } from "path";

import type { EnvironmentDefinition, PortMap } from "@mycadet/environments";
import {
  environmentDirectoryName,
  joinLocalPath,
  resolveConfigHomes,
  resolveDataHome,
} from "@mycadet/local-mode";

const DEFAULT_PORTS: Readonly<PortMap> = {
  daemon: 7821,
  gateway: 7830,
  qdrant: 6333,
  ces: 8090,
  outboundProxy: 8080,
  tcp: 8765,
};

/**
 * Config directory for an environment.
 * Production preserves the existing `~/.config/cadet/` location;
 * non-production environments use `$XDG_CONFIG_HOME/cadet-<env>/`.
 */
export function getConfigDir(env: EnvironmentDefinition): string {
  return getConfigDirs(env)[0]!;
}

export function getConfigDirs(env: EnvironmentDefinition): string[] {
  if (env.configDirOverride) {
    return [env.configDirOverride];
  }
  return resolveConfigHomes().map((home) =>
    joinLocalPath(home, environmentDirectoryName(env.name)),
  );
}

export function getLockfilePaths(env: EnvironmentDefinition): string[] {
  const lockfileDir =
    env.lockfileDirOverride ?? process.env.CADET_LOCKFILE_DIR?.trim();
  if (lockfileDir) {
    return [joinLocalPath(lockfileDir, "lockfile.json")];
  }
  const configDirs = getConfigDirs(env);
  const canonical = joinLocalPath(configDirs[0]!, "lockfile.json");
  if (env.name === "production" || process.platform !== "win32") {
    return [canonical];
  }
  // Windows keeps the pre-AppData XDG location as a legacy read fallback.
  return [canonical, joinLocalPath(configDirs.at(-1)!, "lockfile.json")];
}

/**
 * Canonical lockfile path for writes — always the config-dir
 * `lockfile.json`.
 */
export function getLockfilePath(env: EnvironmentDefinition): string {
  return getLockfilePaths(env)[0]!;
}

/**
 * Multi-instance root directory for an environment. Production uses
 * `~/.local/share/cadet/assistants/` — the convention already in
 * `cli/src/lib/assistant-config.ts`. Non-production environments use
 * `~/.local/share/cadet-<env>/assistants/`.
 */
export function getMultiInstanceDir(env: EnvironmentDefinition): string {
  return joinLocalPath(
    resolveDataHome(),
    environmentDirectoryName(env.name),
    "assistants",
  );
}

/**
 * Default port set for an environment.
 * Seed entries for non-prod environments come with separate port ranges
 * to avoid collisions in multi-env / multi-instance setups.
 * Longer term, consider allocating ports dynamically at hatch/wake time.
 */
export function getDefaultPorts(env: EnvironmentDefinition): PortMap {
  return {
    ...DEFAULT_PORTS,
    ...(env.portsOverride ?? {}),
  };
}

/**
 * Runtime state directory for an environment (upgrade logs, etc.).
 * Production uses `~/.local/share/cadet/`; non-production environments
 * use `~/.local/share/cadet-<env>/`.
 */
export function getStateDir(env: EnvironmentDefinition): string {
  return joinLocalPath(resolveDataHome(), environmentDirectoryName(env.name));
}

export function getLogDir(env: EnvironmentDefinition): string {
  const root =
    process.platform === "win32" ? getStateDir(env) : getConfigDirs(env)[0]!;
  return joinLocalPath(root, "logs");
}

/**
 * The interactive CLI's shared state directory — `$XDG_STATE_HOME/cadet`.
 *
 * Follows the XDG Base Directory spec: session state is data that persists
 * across runs but is not portable user-owned content, mirroring `bash`,
 * `zsh`, `psql`, and `gh`. Defaults to `~/.local/state/cadet`.
 *
 * Not environment-scoped: it holds per-user state (the terminal input
 * history, below) that dev and prod CLIs share.
 */
export function getSharedStateDir(): string {
  return join(xdgStateHome(), "cadet");
}

/**
 * Path to the interactive CLI's input history file, inside
 * {@link getSharedStateDir}. Defaults to
 * `~/.local/state/cadet/input-history`.
 */
export function getInputHistoryPath(): string {
  return join(getSharedStateDir(), "input-history");
}

/**
 * Named port constants derived from `DEFAULT_PORTS`.
 * These are the ports the assistant and gateway services bind to *inside*
 * their container (or process). They are stable across environments.
 */
export const ASSISTANT_INTERNAL_PORT = DEFAULT_PORTS.daemon;
export const GATEWAY_INTERNAL_PORT = DEFAULT_PORTS.gateway;

function xdgStateHome(): string {
  return (
    process.env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state")
  );
}
