import { homedir } from "node:os";
import { join } from "path";

import { DEFAULT_PORTS } from "@mycadet/local-mode";

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
