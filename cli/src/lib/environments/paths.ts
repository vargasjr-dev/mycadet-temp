import { homedir } from "node:os";
import { join } from "path";

import type { EnvironmentDefinition, PortMap } from "@mycadet/environments";
import {
  resolveAssistantsDir,
  resolveConfigDir,
  resolveConfigDirPaths,
  resolveDataDir,
  resolveLockfilePaths,
  resolveLogDir,
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
 * Config directory for the current environment.
 * Production preserves the existing `~/.config/cadet/` location;
 * non-production environments use `$XDG_CONFIG_HOME/cadet-<env>/`.
 */
export function getConfigDir(): string {
  return resolveConfigDir();
}

export function getConfigDirs(): string[] {
  return resolveConfigDirPaths();
}

export function getLockfilePaths(): string[] {
  return resolveLockfilePaths();
}

/**
 * Canonical lockfile path for writes — always the config-dir
 * `lockfile.json`.
 */
export function getLockfilePath(): string {
  return getLockfilePaths()[0]!;
}

/**
 * Multi-instance root directory for the current environment. Production uses
 * `~/.local/share/cadet/assistants/` — the convention already in
 * `cli/src/lib/assistant-config.ts`. Non-production environments use
 * `~/.local/share/cadet-<env>/assistants/`.
 */
export function getMultiInstanceDir(): string {
  return resolveAssistantsDir();
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
 * Runtime state directory for the current environment (upgrade logs, etc.).
 * Production uses `~/.local/share/cadet/`; non-production environments
 * use `~/.local/share/cadet-<env>/`.
 */
export function getStateDir(): string {
  return resolveDataDir();
}

export function getLogDir(): string {
  return resolveLogDir();
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
  return process.env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state");
}
