import { homedir } from "node:os";
import { join } from "path";

import { getCurrentEnvironment } from "./resolve.js";
import type { PortMap } from "@mycadet/environments";

const DEFAULT_PORTS: Readonly<PortMap> = {
  daemon: 7821,
  gateway: 7830,
  qdrant: 6333,
  ces: 8090,
  outboundProxy: 8080,
  tcp: 8765,
};

/**
 * Default port set for an environment.
 * Seed entries for non-prod environments come with separate port ranges
 * to avoid collisions in multi-env / multi-instance setups.
 * Longer term, consider allocating ports dynamically at hatch/wake time.
 */
export function getDefaultPorts(): PortMap {
  return {
    ...DEFAULT_PORTS,
    ...(getCurrentEnvironment().portsOverride ?? {}),
  };
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
