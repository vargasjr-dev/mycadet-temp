/**
 * CES RPC client — assistant-local entry point.
 *
 * Re-exports the shared `@mycadet/ces-client/rpc-client` types and factory
 * so that all assistant-internal consumers (`secure-keys.ts`, `lifecycle.ts`,
 * `server.ts`, etc.) import from this module without a direct package
 * dependency. The process-manager and transport wiring in the assistant
 * remain in the assistant codebase; only the protocol/envelope logic is
 * delegated to the shared package.
 */

import {
  type CesRpcClient,
  type CesRpcClientConfig,
  type CesTransport,
  createCesRpcClient,
} from "@mycadet/ces-client/rpc-client";

import { getLogger } from "../util/logger.js";

const log = getLogger("ces-rpc-client");

/**
 * The transport lifecycle of one CES RPC session. The lifecycle rides on the
 * client itself (`client.stop()` / `client.forceStop()`) — there is no
 * separate session object to keep alive alongside it.
 */
export interface CesClientLifecycle {
  /** Disconnect this session's transport. Idempotent. */
  stop(): Promise<void>;
  /** Shutdown path: disconnects even while `start()` is still in flight. */
  forceStop(): Promise<void>;
}

/** A CES RPC client that owns its transport lifecycle. */
export interface CesSessionClient extends CesRpcClient, CesClientLifecycle {}

/**
 * Construct a CES RPC client wired to the assistant logger so handshake-ready
 * and close transitions are visible in the daemon logs.
 */
export function createCesClient(
  transport: CesTransport,
  config?: CesRpcClientConfig,
): CesRpcClient;
export function createCesClient(
  transport: CesTransport,
  config: CesRpcClientConfig | undefined,
  lifecycle: CesClientLifecycle,
): CesSessionClient;
export function createCesClient(
  transport: CesTransport,
  config?: CesRpcClientConfig,
  lifecycle?: CesClientLifecycle,
): CesRpcClient | CesSessionClient {
  const client = createCesRpcClient(transport, { logger: log, ...config });
  if (lifecycle) {
    return Object.assign(client, lifecycle) as CesSessionClient;
  }
  return client;
}
