/**
 * CES socket discovery and transport bootstrap.
 *
 * Local siblings and managed sidecars share one resolver: `ces.sock` under
 * `CES_SOCKET_DIR` (default `/run/ces-ipc`) — `getBootstrapSocketPath()` from
 * `@mycadet/ces-client/socket-path`, the same resolver CES binds with.
 * Discovery fails closed if the socket cannot be found.
 */

import { existsSync } from "node:fs";

import { getBootstrapSocketPath } from "@mycadet/ces-client/socket-path";
import { isNamedPipePath } from "@mycadet/ipc-server-utils";

import { getLogger } from "../util/logger.js";

const log = getLogger("ces-discovery");

export interface ManagedDiscoverySuccess {
  mode: "managed";
}

export interface DiscoveryFailure {
  mode: "unavailable";
  reason: string;
}

export type DiscoveryResult = ManagedDiscoverySuccess | DiscoveryFailure;

/**
 * Discover CES via the shared bootstrap Unix socket.
 *
 * Checks that the well-known socket exists. Does not open a connection.
 * CES serves a multi-connection listener, so the assistant and its child
 * processes can each connect. The actual connection is made later by
 * `CesProcessManager.start()`, which dials `getBootstrapSocketPath()`
 * directly.
 */
export function discoverCes(): DiscoveryResult {
  const socketPath = getBootstrapSocketPath();

  if (!isNamedPipePath(socketPath) && !existsSync(socketPath)) {
    const reason = `CES socket not found at ${socketPath}`;
    log.warn(reason);
    return { mode: "unavailable", reason };
  }

  log.info({ socketPath }, "CES socket found");
  return { mode: "managed" };
}

/** How long to poll for the CES socket before giving up. */
const MANAGED_DISCOVERY_TIMEOUT_MS = 3_000;

/** Delay between CES socket discovery attempts. */
const MANAGED_DISCOVERY_INTERVAL_MS = 100;

/**
 * Discover CES, polling for the socket with a short backoff before failing.
 *
 * CES binds its socket asynchronously. A reconnecting assistant can probe
 * during the brief window before the socket is re-bound. Polling absorbs
 * that gap.
 */
export async function discoverCesWithRetry({
  timeoutMs = MANAGED_DISCOVERY_TIMEOUT_MS,
  intervalMs = MANAGED_DISCOVERY_INTERVAL_MS,
}: { timeoutMs?: number; intervalMs?: number } = {}): Promise<DiscoveryResult> {
  const deadline = Date.now() + timeoutMs;
  let result = discoverCes();
  while (result.mode === "unavailable" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    result = discoverCes();
  }
  return result;
}
