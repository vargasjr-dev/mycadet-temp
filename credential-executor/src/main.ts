#!/usr/bin/env bun
/**
 * CES (Credential Execution Service) entrypoint.
 *
 * Serves credential CRUD RPC over a Unix socket using a concurrent
 * multi-connection server (`serveStandaloneSocket`). Each connection gets its
 * own `CesRpcServer` over a shared, process-scoped handler registry. The server
 * stays listening across connections, so an assistant that disconnects (crash,
 * restart) can reconnect without CES re-binding.
 *
 * Also starts a health HTTP server (`/healthz`, `/readyz`, optional credential
 * CRUD routes) for liveness/readiness probes.
 */

import { mkdirSync } from "node:fs";
import { createServer as createNetServer, type Socket } from "node:net";
import { dirname } from "node:path";
import { Readable, Writable } from "node:stream";

import {
  CES_PROTOCOL_VERSION,
  CesRpcMethod,
} from "@mycadet/service-contracts/credential-rpc";
import type { SecureKeyBackend } from "@mycadet/credential-storage";
import {
  ipcListenOptions,
  isNamedPipePath,
  removeIpcEndpointFile,
} from "@mycadet/ipc-server-utils";

import { createLocalSecureKeyBackend } from "./materializers/local-secure-key-backend.js";
import {
  getLogger,
  initLogger,
  LOG_RETENTION_SWEEP_INTERVAL_MS,
  pruneOldLogFiles,
} from "./logger.js";
import {
  getCesSocketPath,
  getCesDataRoot,
  getCesLogDir,
  getHealthPort,
  getSecurityDir,
} from "./paths.js";
import { CesRpcServer, type RpcHandlerRegistry } from "./server.js";
import { CES_MIGRATIONS } from "./migrations/registry.js";
import { runCesMigrations } from "./migrations/runner.js";
import { collectCesLogArchive } from "./log-export.js";
import { buildRecordHandlers } from "./records/handlers.js";
import {
  getMetadataStore,
  initMetadataStore,
} from "./records/metadata-store.js";

// ---------------------------------------------------------------------------
// Logging (module-level for early bootstrap + structured logging post-init)
// ---------------------------------------------------------------------------

const log = getLogger("main");

// ---------------------------------------------------------------------------
// Data directory bootstrap
// ---------------------------------------------------------------------------

function ensureDataDirs(): void {
  mkdirSync(getCesDataRoot(), { recursive: true });
}

// ---------------------------------------------------------------------------
// Credential CRUD handlers
// ---------------------------------------------------------------------------

/**
 * Build the RPC handler registry. CES serves credential CRUD (get / set /
 * delete / list / bulk-set) backed by the secure key store. The
 * `update_managed_credential` handler is registered separately by the RPC
 * server when an `onApiKeyUpdate` callback is supplied.
 */
export function buildCrudHandlers(
  secureKeyBackend: SecureKeyBackend,
  audit: Pick<ReturnType<typeof getLogger>, "info"> = log,
): RpcHandlerRegistry {
  const handlers: RpcHandlerRegistry = {};

  handlers[CesRpcMethod.GetCredential] = (async (req: { account: string }) => {
    const value = await secureKeyBackend.get(req.account);
    return { found: value !== undefined, value };
  }) as (typeof handlers)[string];

  handlers[CesRpcMethod.SetCredential] = (async (req: {
    account: string;
    value: string;
  }) => {
    const ok = await secureKeyBackend.set(req.account, req.value);
    // Audit the mutation: account name and outcome only, never the value.
    audit.info({ account: req.account, ok }, "CES credential set");
    if (!ok) {
      return { ok };
    }
    // The store-side invariant: a secret in keys.enc must always have a
    // metadata entry in ces-data, or the catalog cannot see the credential.
    // A bare secret write (hatch provisioning, bulk import) lands here.
    const metadataOk = getMetadataStore().ensureForAccount(req.account);
    if (!metadataOk) {
      audit.info(
        { account: req.account },
        "CES credential set: metadata entry missing after write",
      );
      return { ok: false };
    }
    return { ok };
  }) as (typeof handlers)[string];

  handlers[CesRpcMethod.DeleteCredential] = (async (req: {
    account: string;
  }) => {
    const result = await secureKeyBackend.delete(req.account);
    audit.info({ account: req.account, result }, "CES credential delete");
    return { result };
  }) as (typeof handlers)[string];

  handlers[CesRpcMethod.ListCredentials] = (async () => {
    const accounts = await secureKeyBackend.list();
    return { accounts };
  }) as (typeof handlers)[string];

  handlers[CesRpcMethod.BulkSetCredentials] = (async (req: {
    credentials: Array<{ account: string; value: string }>;
  }) => {
    const results = [];
    for (const { account, value } of req.credentials) {
      const ok = await secureKeyBackend.set(account, value);
      // Same invariant as set_credential: the metadata entry must exist.
      const metadataOk = ok
        ? getMetadataStore().ensureForAccount(account)
        : false;
      const settled = ok && metadataOk;
      audit.info({ account, ok: settled }, "CES credential set (bulk)");
      results.push({ account, ok: settled });
    }
    return { results };
  }) as (typeof handlers)[string];

  return handlers;
}

// ---------------------------------------------------------------------------
// Socket server (unified multi-connection model)
// ---------------------------------------------------------------------------

/**
 * Serve RPC over a Unix socket using a concurrent multi-connection model.
 *
 * Binds the socket, accepts connections concurrently (each served by its own
 * CesRpcServer over the shared handler registry), and unlinks the socket when
 * the signal aborts. The listener stays open across connections so a client
 * that disconnects can reconnect without CES re-binding.
 */
function serveStandaloneSocket(opts: {
  socketPath: string;
  handlers: RpcHandlerRegistry;
  signal: AbortSignal;
  logger: Pick<Console, "log" | "warn" | "error">;
  log: ReturnType<typeof getLogger>;
  onHandshakeComplete?: (
    sessionId: string,
    assistantApiKey?: string,
    assistantId?: string,
  ) => void;
  onApiKeyUpdate?: (assistantApiKey: string, assistantId?: string) => void;
}): void {
  const {
    socketPath,
    handlers,
    signal,
    logger,
    log,
    onHandshakeComplete,
    onApiKeyUpdate,
  } = opts;

  if (!isNamedPipePath(socketPath)) {
    mkdirSync(dirname(socketPath), { recursive: true });
  }
  removeIpcEndpointFile(socketPath);

  const netServer = createNetServer();

  netServer.on("error", (err) => {
    log.warn({ err }, "CES socket server error");
  });

  netServer.on("connection", (socket: Socket) => {
    connectionCount++;
    log.info({ connections: connectionCount }, "CES client connected");
    const readable = new Readable({ read() {} });
    const writable = new Writable({
      write(chunk, _encoding, callback) {
        if (socket.writable) {
          socket.write(chunk, callback);
        } else {
          callback(new Error("Socket no longer writable"));
        }
      },
    });
    socket.on("data", (chunk) => readable.push(chunk));
    socket.on("end", () => readable.push(null));
    socket.on("error", (err) => {
      readable.destroy(err);
      writable.destroy(err);
    });

    const server = new CesRpcServer({
      input: readable,
      output: writable,
      handlers,
      logger,
      signal,
      onHandshakeComplete: (sessionId, apiKey, assistantId) => {
        onHandshakeComplete?.(sessionId, apiKey, assistantId);
      },
      onApiKeyUpdate: onApiKeyUpdate ?? (() => {}),
    });
    void server
      .serve()
      .catch((err) => {
        server.close();
        log.warn({ err }, "CES connection ended with a transport error");
      })
      .then(() => {
        connectionCount = Math.max(0, connectionCount - 1);
        log.info({ connections: connectionCount }, "CES client disconnected");
      });
  });

  netServer.listen(ipcListenOptions(socketPath), () => {
    log.info(`CES socket listening at ${socketPath}`);
  });

  signal.addEventListener(
    "abort",
    () => {
      netServer.close();
      removeIpcEndpointFile(socketPath);
    },
    { once: true },
  );
}

// ---------------------------------------------------------------------------
// Health server
// ---------------------------------------------------------------------------

let connectionCount = 0;

function startHealthServer(
  port: number,
  signal: AbortSignal,
): ReturnType<typeof Bun.serve> | null {
  // Listen on every interface so kubelet httpGet probes can hit the pod IP.
  // This port serves liveness/readiness probes ONLY — credential invocation
  // is IPC-only over the shared Unix socket.
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      port,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/healthz") {
          return new Response(JSON.stringify({ status: "ok" }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.pathname === "/readyz") {
          // Always return 200: pod readiness must not depend on whether the
          // assistant has connected.  When the CES feature flag is off the
          // assistant never connects, and a 503 here would block pod
          // scheduling during dark-launch.  The sidecar can't do useful work
          // without a connection anyway, so readiness is purely about the
          // process being up and able to accept a future connection.
          return new Response(
            JSON.stringify({
              status: "ok",
              connections: connectionCount,
              rpcConnected: connectionCount > 0,
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        return new Response("Not Found", { status: 404 });
      },
    });
  } catch (err) {
    // A health-port collision must never take the credential store down:
    // local callers reach the CES over the Unix socket, so a failed HTTP
    // surface degrades to socket-only service. An EADDRINUSE here used to
    // kill the CES milliseconds into boot — with the async log
    // destination swallowing the fatal — which surfaced downstream as
    // "credential-executor socket not ready" and a 502 for every
    // credential read during hatch.
    log.error(
      { err, port },
      "CES health server failed to bind — continuing socket-only",
    );
    return null;
  }

  signal.addEventListener(
    "abort",
    () => {
      server.stop(true);
    },
    { once: true },
  );

  return server;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  ensureDataDirs();

  initLogger({ dir: getCesLogDir(), retentionDays: 30 });
  startLogRetentionSweep();

  /**
   * Background log-retention sweep (field feedback item 8): the prune left
   * initLogger's critical path. This process is short-lived — the interval is
   * unref'd so it never blocks exit; it simply prunes opportunistically while
   * the process is alive.
   */
  function startLogRetentionSweep(): void {
    const interval = setInterval(() => {
      try {
        const removed = pruneOldLogFiles(getCesLogDir(), 30);
        if (removed > 0) {
          log.info({ removed }, "Pruned old CES log files");
        }
      } catch (err) {
        log.warn({ err }, "CES log retention sweep failed");
      }
    }, LOG_RETENTION_SWEEP_INTERVAL_MS);
    interval.unref();
  }

  log.info(`Starting CES v${CES_PROTOCOL_VERSION} (socket transport)`);

  const controller = new AbortController();

  // Graceful shutdown on SIGTERM / SIGINT
  const shutdown = () => {
    log.info("Shutting down...");
    controller.abort();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // -- Secure key backend + migrations --------------------------------------
  // Both modes resolve the store location through getSecurityDir() (env var,
  // cwd fallback convention) — see paths.ts.
  const secureKeyBackend = createLocalSecureKeyBackend(getSecurityDir());

  await runCesMigrations(getCesDataRoot(), secureKeyBackend, CES_MIGRATIONS);
  log.info("CES startup: migrations complete");

  initMetadataStore();

  // -- Build handlers --------------------------------------------------------
  // The per-connection session ID lives in each CesRpcServer's SessionContext;
  // handlers read it at call time. The registry is shared across connections
  // and identical in both modes.
  const handlers = {
    ...buildCrudHandlers(secureKeyBackend),
    ...buildRecordHandlers(),
  };
  // Diagnostic log export (tar.gz, base64) — the gateway pulls CES logs
  // through the same socket as everything else.
  handlers[CesRpcMethod.ExportLogs] = (async (req: {
    startTime?: number;
    endTime?: number;
  }) =>
    await collectCesLogArchive(
      req.startTime,
      req.endTime,
    )) as (typeof handlers)[string];

  // -- Health server ----------------------------------------------------------
  // Liveness/readiness probes only. Credential invocation is IPC-only.
  const healthPort = getHealthPort();
  startHealthServer(healthPort, controller.signal);
  log.info(`Health server listening on port ${healthPort}`);

  // -- Socket server ---------------------------------------------------------
  const socketPath = getCesSocketPath();

  const rpcLog = getLogger("rpc");
  const rpcLogger = {
    log: (msg: string, ...args: unknown[]) => rpcLog.info({ args }, msg),
    warn: (msg: string, ...args: unknown[]) => rpcLog.warn({ args }, msg),
    error: (msg: string, ...args: unknown[]) => rpcLog.error({ args }, msg),
  };

  // The `update_managed_credential` handler (via the `onApiKeyUpdate` hook)
  // lets the assistant push its API key/ID after hatch.
  // The push is acknowledged and logged; CES stores credentials via the CRUD
  // handlers and no longer materializes platform tokens itself.
  serveStandaloneSocket({
    socketPath,
    handlers,
    signal: controller.signal,
    logger: rpcLogger,
    log,
    onApiKeyUpdate: (newKey: string, newAssistantId?: string) => {
      // Ack-only. CES reads the durable assistant API key from the shared
      // credential store via the CRUD handlers; this RPC just acknowledges
      // the assistant's notification that the key rotated. The pushed
      // value is intentionally not persisted here (length logged, never
      // the value).
      log.info(
        {
          keyBytes: newKey.length,
          assistantIdUpdated: Boolean(newAssistantId),
        },
        "Acknowledged assistant API key update notification (ack only; value not stored by CES)",
      );
    },
  });

  await new Promise<void>((resolve) => {
    if (controller.signal.aborted) {
      resolve();
      return;
    }
    controller.signal.addEventListener("abort", () => resolve(), {
      once: true,
    });
  });
  log.info("Server stopped.");
}

if (import.meta.main) {
  main().catch((err) => {
    try {
      getLogger("main").fatal({ err }, "Fatal error");
    } catch {
      process.stderr.write(`[ces] Fatal: ${err}\n`);
    }
    process.exit(1);
  });
}
