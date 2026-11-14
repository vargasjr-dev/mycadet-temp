/**
 * Open a CES RPC client over the shared IPC socket.
 *
 * Assistant boot and child-process credential reads use this helper. Both
 * are CES API clients: discover `ces.sock`, connect, handshake. Each opened
 * session owns its transport lifecycle through the returned client
 * (`client.stop()` / `client.forceStop()`); reconnect opens a fresh session.
 */

import type { CesRpcHandshakeOptions } from "@mycadet/ces-client/rpc-client";

import type { AssistantConfig } from "../config/schema.js";
import { getLogger } from "../util/logger.js";
import { type CesSessionClient, createCesClient } from "./client.js";
import {
  type CesProcessManagerConfig,
  CesUnavailableError,
  createCesProcessManager,
} from "./process-manager.js";

const log = getLogger("ces-connect");

export interface OpenCesRpcSessionOptions {
  handshake?: CesRpcHandshakeOptions;
  signal?: AbortSignal;
  assistantConfig?: AssistantConfig;
  discover?: CesProcessManagerConfig["discover"];
  /** Fired when the session's transport dies (the reconnect trigger). */
  onTransportClose?: () => void;
}

/**
 * Discover the CES socket, connect, and complete the RPC handshake.
 *
 * Returns undefined when CES is missing, the handshake is rejected, the
 * abort signal fires, or the transport fails. The session's transport is
 * stopped on those paths so a later call can open a fresh session.
 */
export async function openCesRpcSession(
  options: OpenCesRpcSessionOptions = {},
): Promise<CesSessionClient | undefined> {
  const pm = createCesProcessManager({
    assistantConfig: options.assistantConfig,
    discover: options.discover,
  });
  if (options.onTransportClose) {
    pm.onTransportClose(options.onTransportClose);
  }

  const fail = async (): Promise<undefined> => {
    await pm.stop().catch(() => {});
    return undefined;
  };

  if (options.signal?.aborted) {
    return fail();
  }

  try {
    const transport = await pm.start();
    if (options.signal?.aborted) {
      return fail();
    }

    const client = createCesClient(transport, undefined, {
      stop: () => pm.stop(),
      forceStop: () => pm.forceStop(),
    });

    const { accepted, reason } = await client.handshake(options.handshake);
    if (options.signal?.aborted) {
      client.close();
      return fail();
    }
    if (!accepted) {
      log.warn({ reason }, "CES handshake rejected");
      client.close();
      return fail();
    }

    return client;
  } catch (err) {
    if (err instanceof CesUnavailableError) {
      log.info({ reason: err.message }, "CES is not available");
    } else {
      log.warn(
        { error: err instanceof Error ? err.message : String(err) },
        "Failed to open CES RPC session",
      );
    }
    return fail();
  }
}
