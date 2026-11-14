import type { CesRpcClient as CesClient } from "@mycadet/ces-client/rpc-client";
import type { CesRpcHandshakeOptions as CesClientHandshakeOptions } from "@mycadet/ces-client/rpc-client";

import { getCloudAssistantId } from "../config/env.js";
import type { AssistantConfig } from "../config/schema.js";
import { resolveCloudProxyContext } from "../providers/cloud-proxy/context.js";
import { cesRecordBackend } from "../security/ces-rpc-record-backend.js";
import { getLogger } from "../util/logger.js";
import { openCesRpcSession, reconnectCesRpcSession } from "./ces-connect.js";
import {
  type CesProcessManager,
  createCesProcessManager,
} from "./process-manager.js";

const log = getLogger("ces-runtime");

/**
 * Process-level singleton owning the daemon's live CES (Credential Execution
 * Service) connection. `startCes()` performs the full handshake + reconnect
 * wiring at daemon startup; `getCesClient()` exposes the live client to routes;
 * `stopCes()` tears it down at shutdown.
 */

let processManager: CesProcessManager | undefined;
let clientPromise: Promise<CesClient | undefined> | undefined;
let initAbortController: AbortController | undefined;
let clientRef: CesClient | undefined;
/** Monotonically increasing counter to detect stale client updates. */
let clientGeneration = 0;
/** Boot-session reconnect, set by startCesProcess and used by the proactive loop. */
let reconnectBootSession: (() => Promise<CesClient | undefined>) | undefined;

interface CesStartupResult {
  client: CesClient | undefined;
  processManager: CesProcessManager | undefined;
  clientPromise: Promise<CesClient | undefined> | undefined;
  abortController: AbortController | undefined;
}

/**
 * Open the assistant's CES RPC client and perform the handshake. Returns
 * immediately with handles to the in-flight initialization: callers don't
 * need to await this for startup to continue.
 *
 * Claims reconnect ownership before any credential read so boot identity
 * loading cannot open a second, identity-less session through the child
 * entry point. CES serves a multi-connection Unix socket, so child
 * processes in other address spaces still open their own connections.
 */
function startCesProcess(config: AssistantConfig): CesStartupResult {
  const pm = createCesProcessManager({ assistantConfig: config });
  const abortController = new AbortController();
  let currentClient: CesClient | undefined;
  let handshake: CesClientHandshakeOptions = {};

  // Reconnect the boot session in-process: the fresh client updates
  // `currentClient`/`clientRef` directly (the record backend reconnects its
  // own session independently).
  reconnectBootSession = async (): Promise<CesClient | undefined> => {
    const client = await reconnectCesRpcSession(pm, handshake);
    if (client) {
      log.info("CES reconnection handshake accepted");
      currentClient = client;
      clientGeneration++;
      clientRef = client;
    }
    return client;
  };

  const handshakePromise = (async (): Promise<CesClient | undefined> => {
    try {
      // Resolve the assistant API key so CES can use it for platform
      // credential materialisation. In managed mode the key is provisioned
      // after hatch and stored in the credential store. CES can't read
      // the env var, so we pass it via the handshake. Reconnect ownership
      // is already claimed, so this read uses HTTP or the encrypted store,
      // not a second RPC session.
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
      const session = await openCesRpcSession({
        processManager: pm,
        signal: abortController.signal,
        handshake,
      });
      currentClient = session?.client;
      if (session) {
        log.info(
          "CES client initialized and handshake accepted (server-level)",
        );
      }
      return session?.client;
    } catch (err) {
      log.warn(
        { error: err instanceof Error ? err.message : String(err) },
        "Failed to initialize CES client",
      );
      currentClient = undefined;
      await pm.stop().catch(() => {});
      return undefined;
    }
  })();

  return {
    get client() {
      return currentClient;
    },
    processManager: pm,
    clientPromise: handshakePromise,
    abortController,
  };
}

/** Store the startup handles so getCesClient()/stopCes() can reach them. */
function applyCesResult(result: CesStartupResult): void {
  clientRef = result.client;
  processManager = result.processManager;
  initAbortController = result.abortController;

  // Wrap the handshake promise so clientRef stays in sync once it resolves.
  // Use a generation snapshot so a late-resolving promise doesn't overwrite a
  // newer client set by a reconnection.
  if (result.clientPromise) {
    const gen = clientGeneration;
    clientPromise = result.clientPromise.then((client) => {
      if (clientGeneration === gen) {
        clientRef = client;
      }
      return client;
    });
  }
}

/**
 * Open the assistant's CES RPC client: handshake (blocking up to a 20s
 * timeout so the boot session — the one that hands CES the assistant API
 * key — is established before provider init) and keep the live client
 * reference in sync. Non-fatal on failure: credential reads route through
 * the record backend's own lazily opened session regardless.
 */
export async function startCes(config: AssistantConfig): Promise<void> {
  const cesResult = startCesProcess(config);

  // Non-blocking by design: the assistant's overall health check (readyz)
  // owns CES readiness — it reports the live handshake state and nudges the
  // single-flight connect, so boot never waits on CES here. The boot session
  // (which hands CES the assistant API key) establishes in the background via
  // clientPromise; applyCesResult keeps clientRef in sync once it resolves.

  // Reconnect ownership is claimed inside startCesProcess before the
  // identity read. Snapshotting the API key there (not here) avoids a
  // second resolveCloudProxyContext() after the handshake, which would
  // read the key through CES while reconnecting.
  if (cesResult.processManager) {
    const pm = cesResult.processManager;

    // Proactive reconnect: when the transport dies (socket close, process
    // exit), start a retry-with-backoff loop immediately instead of waiting
    // for the next credential operation to trigger the lazy reconnect path.
    // The loop calls attemptCesReconnection(), which shares the same dedup +
    // cooldown machinery as the lazy path, so concurrent credential ops and
    // the proactive loop never race on pm.stop()/pm.start().
    pm.onTransportClose(() => {
      startProactiveReconnectLoop(pm);
    });
  }

  applyCesResult(cesResult);
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
  // Force-stop the CES process immediately — forceStop() works even if
  // start() hasn't finished (unlike stop() which is a no-op when !running).
  if (processManager) {
    await processManager.forceStop().catch(() => {});
  }
  // Cancel in-flight handshake/RPC timers by closing the client directly.
  // Without this, the handshake setTimeout (~10s) keeps the init promise
  // pending even after the transport is killed.
  if (clientRef) {
    clientRef.close();
    clientRef = undefined;
  }
  // Now await the init promise (which should settle immediately since we
  // killed the transport and cancelled pending timers above).
  if (clientPromise) {
    await clientPromise.catch(() => undefined);
    clientPromise = undefined;
  }
  processManager = undefined;
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
function startProactiveReconnectLoop(_pm: CesProcessManager): void {
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

      // Stop if the daemon is shutting down (processManager cleared).
      if (!processManager) {
        log.info("Proactive reconnect loop stopped — process manager gone");
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
