import type { CesRpcClient as CesClient } from "@mycadet/ces-client/rpc-client";
import type { CesRpcHandshakeOptions as CesClientHandshakeOptions } from "@mycadet/ces-client/rpc-client";

import { getCloudAssistantId } from "../config/env.js";
import type { AssistantConfig } from "../config/schema.js";
import { resolveCloudProxyContext } from "../providers/cloud-proxy/context.js";
import { cesRecordBackend } from "../security/ces-rpc-record-backend.js";
import { getLogger } from "../util/logger.js";
import { openCesRpcSession } from "./ces-connect.js";
import type { CesSessionClient } from "./client.js";

const log = getLogger("ces-runtime");

/**
 * Process-level singleton owning the daemon's live CES (Credential Execution
 * Service) connection. `initializeCesClient()` connects and handshakes at
 * daemon startup; `getCesClient()` exposes the live client to routes;
 * `stopCes()` tears it down at shutdown.
 */

let clientPromise: Promise<CesClient | undefined> | undefined;
let initAbortController: AbortController | undefined;
let clientRef: CesSessionClient | undefined;
/** Monotonically increasing counter to detect stale client updates. */
let clientGeneration = 0;
/** Boot-session reconnect, set by initializeCesClient and used by the proactive loop. */
let reconnectBootSession: (() => Promise<CesClient | undefined>) | undefined;

/**
 * Initialize the assistant's CES RPC client: discover the socket, connect,
 * and handshake (blocking up to a 20s timeout so the boot session — the one
 * that hands CES the assistant API key — is established before provider
 * init). Boot does not await this: readyz owns CES readiness, credential
 * reads route through the record backend's own lazily opened session, and
 * `clientRef` is updated once the handshake resolves.
 */
export async function initializeCesClient(
  _config: AssistantConfig,
): Promise<void> {
  const abortController = new AbortController();
  initAbortController = abortController;
  let handshake: CesClientHandshakeOptions = {};
  const generation = ++clientGeneration;

  reconnectBootSession = async (): Promise<CesClient | undefined> => {
    // Reset the dead session's transport, then open a fresh one — the
    // replacement re-registers its own transport-close hook.
    await clientRef?.stop().catch(() => {});
    const client = await openCesRpcSession({
      handshake,
      onTransportClose: () => startProactiveReconnectLoop(),
    });
    if (client) {
      log.info("CES reconnection handshake accepted");
      clientGeneration++;
      clientRef = client;
    }
    return client;
  };

  // Reconnect ownership is claimed above, before the identity read.
  // Snapshotting the API key inside this promise (not before it) avoids a
  // second resolveCloudProxyContext() after the handshake, which would read
  // the key through CES while reconnecting.
  clientPromise = (async (): Promise<CesClient | undefined> => {
    try {
      // Resolve the assistant API key so CES can use it for platform
      // credential materialisation. In managed mode the key is provisioned
      // after hatch and stored in the credential store. CES can't read
      // the env var, so we pass it via the handshake.
      const proxyCtx = await resolveCloudProxyContext();
      if (abortController.signal.aborted) {
        return undefined;
      }
      const assistantId = getCloudAssistantId();
      handshake = {
        ...(proxyCtx.assistantApiKey
          ? { assistantApiKey: proxyCtx.assistantApiKey }
          : {}),
        ...(assistantId ? { assistantId } : {}),
      };
      const client = await openCesRpcSession({
        signal: abortController.signal,
        handshake,
        onTransportClose: () => startProactiveReconnectLoop(),
      });
      if (client && clientGeneration === generation) {
        clientRef = client;
        log.info(
          "CES client initialized and handshake accepted (server-level)",
        );
      }
      return client;
    } catch (err) {
      log.warn(
        { error: err instanceof Error ? err.message : String(err) },
        "Failed to initialize CES client",
      );
      if (clientGeneration === generation) {
        clientRef = undefined;
      }
      return undefined;
    }
  })();
}

/**
 * Return the CES client reference (if available). Used by routes that need to
 * push updates to CES (e.g. secret-routes).
 */
export function getCesClient(): CesClient | undefined {
  return clientRef;
}

/** Tear down the CES connection during daemon shutdown. */
export async function stopCes(): Promise<void> {
  // Suppress the proactive reconnect loop — forceStop() closes the
  // transport, which would otherwise trigger onTransportClose and start
  // a reconnect loop racing against this shutdown.
  shuttingDown = true;
  // Drop the record backend's own session too.
  await cesRecordBackend.close().catch(() => {});
  // Abort any in-flight CES initialization so it fails fast instead of
  // blocking shutdown for up to ~15s (socket connect + handshake timeouts).
  if (initAbortController) {
    initAbortController.abort();
    initAbortController = undefined;
  }
  // Force-stop the live session's transport — forceStop() works even if
  // start() hasn't finished (unlike stop() which is a no-op when !running).
  if (clientRef) {
    await clientRef.forceStop().catch(() => {});
    // Cancel in-flight handshake/RPC timers by closing the client directly.
    // Without this, the handshake setTimeout (~10s) keeps the init promise
    // pending even after the transport is killed.
    clientRef.close();
    clientRef = undefined;
  }
  // Now await the init promise (which should settle immediately since we
  // killed the transport and cancelled pending timers above).
  if (clientPromise) {
    await clientPromise.catch(() => undefined);
    clientPromise = undefined;
  }
  reconnectBootSession = undefined;
  proactiveReconnectInFlight = false;
}

// ---------------------------------------------------------------------------
// Proactive reconnect loop
// ---------------------------------------------------------------------------

/**
 * Backoff schedule for proactive reconnection attempts (milliseconds).
 * The first attempt fires immediately (0ms); subsequent attempts use
 * exponential backoff capped at 30s.
 */
const RECONNECT_BACKOFF_MS = [0, 2_000, 5_000, 10_000, 20_000, 30_000];

/** Maximum reconnection attempts before giving up and relying on the lazy path. */
const MAX_RECONNECT_ATTEMPTS = RECONNECT_BACKOFF_MS.length;

/**
 * Track the active reconnect loop so a new transport-close event (e.g. from
 * a failed reconnect's own transport dying) doesn't start a second loop.
 */
let proactiveReconnectInFlight = false;
/** Set to true during stopCes() so the proactive reconnect loop doesn't fire
 * when forceStop() intentionally closes the transport. */
let shuttingDown = false;

/**
 * Start a retry-with-backoff loop that proactively re-establishes the boot
 * CES session after the transport dies. Each attempt calls the boot-session
 * reconnect (which re-handshakes with the assistant API key and updates
 * `clientRef`). The record backend reconnects its own session independently,
 * cooldown-gated, on the next credential/record operation.
 */
function startProactiveReconnectLoop(): void {
  if (shuttingDown) {
    log.debug("CES shutting down — not starting proactive reconnect loop");
    return;
  }
  if (proactiveReconnectInFlight) {
    log.debug("Proactive reconnect loop already running — skipping");
    return;
  }
  proactiveReconnectInFlight = true;

  void (async () => {
    log.warn("CES transport died — starting proactive reconnect loop");

    for (let attempt = 0; attempt < MAX_RECONNECT_ATTEMPTS; attempt++) {
      const delay = RECONNECT_BACKOFF_MS[attempt];
      if (delay > 0) {
        await sleep(delay);
      }

      // Stop if the daemon is shutting down.
      if (shuttingDown) {
        log.info("Proactive reconnect loop stopped — shutdown in progress");
        break;
      }

      try {
        const client = await reconnectBootSession?.();
        if (client) {
          log.info(
            { attempt: attempt + 1 },
            "Proactive CES reconnection succeeded",
          );
          break;
        }
        log.warn(
          { attempt: attempt + 1, max: MAX_RECONNECT_ATTEMPTS },
          "Proactive CES reconnection attempt did not succeed",
        );
      } catch (err) {
        log.warn(
          {
            attempt: attempt + 1,
            max: MAX_RECONNECT_ATTEMPTS,
            error: err instanceof Error ? err.message : String(err),
          },
          "Proactive CES reconnection attempt threw",
        );
      }
    }

    proactiveReconnectInFlight = false;
    log.info("Proactive reconnect loop finished");
  })();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
