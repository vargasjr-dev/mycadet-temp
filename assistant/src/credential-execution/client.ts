/**
 * CES RPC client — assistant-local entry point.
 *
 * The session fully owns its transport lifecycle: the process manager,
 * socket discovery, handshake, and reconnection all live here. Consumers
 * call `createCesClient()` and get back a stable client reference whose
 * transport self-heals — when the socket dies the session reconnects with
 * the same handshake (exponential backoff, capped) without the caller
 * seeing a new object. `client.stop()` / `client.forceStop()` tear the
 * session down and disable reconnection.
 *
 * Only the protocol/envelope logic is delegated to the shared
 * `@mycadet/ces-client` package; the process-manager wiring stays in the
 * assistant codebase.
 */

import {
  CesClientError,
  type CesRpcClient,
  type CesRpcClientConfig,
  type CesRpcHandshakeOptions,
  createCesRpcClient,
} from "@mycadet/ces-client/rpc-client";

import { getLogger } from "../util/logger.js";
import { CesUnavailableError, createCesProcessManager } from "./process-manager.js";

const log = getLogger("ces-rpc-client");

/**
 * Backoff schedule for a session's proactive reconnection attempts
 * (milliseconds). The first attempt fires immediately (0ms); subsequent
 * attempts use exponential backoff capped at 30s.
 */
const RECONNECT_BACKOFF_MS = [0, 2_000, 5_000, 10_000, 20_000, 30_000];

/** Maximum reconnection attempts before the session gives up and relies on
 * callers lazily opening a fresh one. */
const MAX_RECONNECT_ATTEMPTS = RECONNECT_BACKOFF_MS.length;

/**
 * The transport lifecycle of one CES RPC session. The lifecycle rides on the
 * client itself (`client.stop()` / `client.forceStop()`) — there is no
 * separate session object to keep alive alongside it.
 */
export interface CesClientLifecycle {
  /** Disconnect this session's transport. Idempotent. Disables reconnection. */
  stop(): Promise<void>;
  /** Shutdown path: disconnects even while a connect is still in flight. */
  forceStop(): Promise<void>;
}

/** A CES RPC client that owns its transport lifecycle and reconnection. */
export interface CesSessionClient extends CesRpcClient, CesClientLifecycle {}

export interface CesSessionClientOptions {
  /** Handshake material reused verbatim across reconnections. */
  handshake?: CesRpcHandshakeOptions;
  /** Abort signal — aborts the initial connect and any reconnect loop. */
  signal?: AbortSignal;
  /** Socket discovery override. Tests inject a stub. */
  discover?: Parameters<typeof createCesProcessManager>[0]["discover"];
  /** RPC/handshake timeouts forwarded to the shared client. */
  config?: CesRpcClientConfig;
}

/**
 * Open a CES RPC session: discover the socket, connect, handshake, and own
 * the transport from then on — a dead transport triggers an in-session
 * reconnection (same handshake, bounded backoff) instead of surfacing a
 * close callback to the caller.
 *
 * Returns undefined when CES is missing, the handshake is rejected, or the
 * abort signal fires. The transport is stopped on those paths so a later
 * call can open a fresh session.
 */
export async function createCesClient(
  options: CesSessionClientOptions = {},
): Promise<CesSessionClient | undefined> {
  const pm = createCesProcessManager({ discover: options.discover });
  const handshake = options.handshake;
  const signal = options.signal;

  let inner: CesRpcClient | undefined;
  let stopping = false;
  let reconnecting = false;

  const stopInternal = async (force: boolean): Promise<void> => {
    stopping = true;
    inner?.close();
    inner = undefined;
    await (force ? pm.forceStop() : pm.stop()).catch(() => {});
  };

  /** Connect + handshake one transport. Returns the ready inner client. */
  const connectOnce = async (): Promise<CesRpcClient> => {
    const transport = await pm.start();
    const rpc = createCesRpcClient(transport, { logger: log, ...options.config });
    const { accepted, reason } = await rpc.handshake(handshake);
    if (!accepted) {
      rpc.close();
      throw new Error(reason ? `CES handshake rejected: ${reason}` : "CES handshake rejected");
    }
    return rpc;
  };

  /**
   * Reconnect with bounded backoff after the transport dies. The live inner
   * client is swapped in place, so consumers holding the session reference
   * keep calling the same object.
   */
  const scheduleReconnect = (): void => {
    if (stopping || signal?.aborted) {
      return;
    }
    if (reconnecting) {
      return;
    }
    reconnecting = true;

    void (async () => {
      log.warn("CES transport died — starting in-session reconnect loop");

      for (let attempt = 0; attempt < MAX_RECONNECT_ATTEMPTS; attempt++) {
        const delay = RECONNECT_BACKOFF_MS[attempt];
        if (delay > 0) {
          await sleep(delay);
        }
        if (stopping || signal?.aborted) {
          reconnecting = false;
          log.info("CES reconnect loop stopped — session is closing");
          return;
        }
        try {
          // The transport died but the pm still counts as running; reset it
          // so start() opens a fresh socket.
          await pm.stop().catch(() => {});
          inner = await connectOnce();
          reconnecting = false;
          log.info(
            { attempt: attempt + 1 },
            "CES session reconnected and handshake accepted",
          );
          return;
        } catch (err) {
          log.warn(
            {
              attempt: attempt + 1,
              max: MAX_RECONNECT_ATTEMPTS,
              error: err instanceof Error ? err.message : String(err),
            },
            "CES session reconnection attempt did not succeed",
          );
        }
      }

      reconnecting = false;
      log.info("CES reconnect loop finished — later ops reopen lazily");
    })();
  };

  pm.onTransportClose(() => scheduleReconnect());

  // Stable delegating surface: consumers keep one reference while the inner
  // client is swapped underneath it across reconnections.
  const session: CesSessionClient = {
    handshake(sessionOptions) {
      return inner
        ? inner.handshake(sessionOptions)
        : Promise.resolve({ accepted: false, reason: "CES session is closed" });
    },
    call(method, request) {
      if (!inner) {
        return Promise.reject(
          new CesClientError("CES session is closed"),
        );
      }
      return inner.call(method, request);
    },
    updateAssistantApiKey(assistantApiKey, assistantId) {
      if (!inner) {
        return Promise.resolve({ updated: false });
      }
      return inner.updateAssistantApiKey(assistantApiKey, assistantId);
    },
    isReady() {
      return inner?.isReady() ?? false;
    },
    close() {
      stopping = true;
      inner?.close();
      inner = undefined;
    },
    stop() {
      return stopInternal(false);
    },
    forceStop() {
      return stopInternal(true);
    },
  };

  if (signal?.aborted) {
    await pm.stop().catch(() => {});
    return undefined;
  }

  try {
    inner = await connectOnce();
    return session;
  } catch (err) {
    if (err instanceof CesUnavailableError) {
      log.info({ reason: err.message }, "CES is not available");
    } else {
      log.warn(
        { error: err instanceof Error ? err.message : String(err) },
        "Failed to open CES RPC session",
      );
    }
    stopping = true;
    inner?.close();
    inner = undefined;
    await pm.stop().catch(() => {});
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
