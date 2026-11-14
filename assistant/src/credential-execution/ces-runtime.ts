import type { CesRpcClient as CesClient } from "@mycadet/ces-client/rpc-client";
import type { CesRpcHandshakeOptions as CesClientHandshakeOptions } from "@mycadet/ces-client/rpc-client";

import { getCloudAssistantId } from "../config/env.js";
import { resolveCloudProxyContext } from "../providers/cloud-proxy/context.js";
import { cesRecordBackend } from "../security/ces-rpc-record-backend.js";
import { getLogger } from "../util/logger.js";
import { type CesSessionClient, createCesClient } from "./client.js";

const log = getLogger("ces-runtime");

/**
 * Process-level singleton owning the daemon's live CES (Credential Execution
 * Service) connection. `initializeCesClient()` connects and handshakes at
 * daemon startup; `getCesClient()` exposes the live client to routes;
 * `stopCes()` tears it down at shutdown.
 *
 * Reconnection is owned by the session itself: a dead transport triggers the
 * client's in-session reconnect loop (same handshake, bounded backoff), so
 * the `clientRef` reference stays stable across CES restarts.
 */

let clientPromise: Promise<CesClient | undefined> | undefined;
let initAbortController: AbortController | undefined;
let clientRef: CesSessionClient | undefined;
/** Monotonically increasing counter to detect stale client updates. */
let clientGeneration = 0;

/**
 * Initialize the assistant's CES RPC client: discover the socket, connect,
 * and handshake (blocking up to a 20s timeout so the boot session — the one
 * that hands CES the assistant API key — is established before provider
 * init). Boot does not await this: readyz owns CES readiness, credential
 * reads route through the record backend's own lazily opened session, and
 * `clientRef` is updated once the handshake resolves.
 */
export async function initializeCesClient(): Promise<void> {
  const abortController = new AbortController();
  initAbortController = abortController;
  const generation = ++clientGeneration;

  // Snapshot the API key inside this promise (not before it) to avoid a
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
      const handshake: CesClientHandshakeOptions = {
        ...(proxyCtx.assistantApiKey
          ? { assistantApiKey: proxyCtx.assistantApiKey }
          : {}),
        ...(assistantId ? { assistantId } : {}),
      };
      const client = await createCesClient({
        signal: abortController.signal,
        handshake,
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
  // Drop the record backend's own session too.
  await cesRecordBackend.close().catch(() => {});
  // Abort any in-flight CES initialization so it fails fast instead of
  // blocking shutdown for up to ~15s (socket connect + handshake timeouts).
  if (initAbortController) {
    initAbortController.abort();
    initAbortController = undefined;
  }
  // Force-stop the live session's transport — forceStop() works even if
  // start() hasn't finished (unlike stop() which is a no-op when not
  // connected), and it disables the session's own reconnection loop.
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
}
