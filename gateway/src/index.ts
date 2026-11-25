import { randomBytes } from "node:crypto";
import { TWILIO_MEDIA_STREAM_WEBHOOK_PATH } from "@mycadet/service-contracts/twilio-ingress";
import { getAuthRateLimiter } from "./auth-rate-limiter.js";
import { initSigningKey } from "./auth/token-service.js";
import { forwardedIdentityHeaders } from "@mycadet/assistant-client";
import { startConfigFileWatcher } from "./config-file-watcher.js";
import { loadConfig } from "./config.js";
import { CircuitBreakerOpenError } from "./runtime/client.js";
import { getCredentials } from "./credential-cache.js";
import { startCredentialWatcher } from "./credential-watcher.js";
import {
  closeTwilioMediaStream,
  handleTwilioMediaWs,
  isMediaStreamSocketData,
  messageTwilioMediaStream,
  openTwilioMediaWebsocket,
} from "./http/routes/twilio-media-websocket.js";
import {
  closeSttStreamWebsocket,
  handleSttStreamWs,
  isSttStreamSocketData,
  messageSttStreamWebsocket,
  openSttStreamWebsocket,
} from "./http/routes/stt-stream-websocket.js";
import {
  closeWatchStreamWebsocket,
  handleWatchStreamWs,
  isWatchStreamSocketData,
  messageWatchStreamWebsocket,
  openWatchStreamWebsocket,
} from "./http/routes/watch-stream-websocket.js";
import {
  closeDesktopStreamWebsocket,
  handleDesktopStreamWs,
  isDesktopStreamSocketData,
  messageDesktopStreamWebsocket,
  openDesktopStreamWebsocket,
} from "./http/routes/desktop-stream-websocket.js";
import {
  closeSpeechRelayWebsocket,
  handleSpeechRelaySttWs,
  handleSpeechRelaySttV2Ws,
  handleSpeechRelayTtsWs,
  isSpeechRelaySocketData,
  messageSpeechRelayWebsocket,
  openSpeechRelayWebsocket,
} from "./http/routes/speech-relay-websocket.js";
import {
  closeLiveVoiceWebsocket,
  handleLiveVoiceWs,
  isLiveVoiceSocketData,
  messageLiveVoiceWebsocket,
  openLiveVoiceWebsocket,
} from "./http/routes/live-voice-websocket.js";
import { initTrustRuleCache } from "./risk/trust-rule-cache.js";
import { initAdmissionPolicyCache } from "./risk/admission-policy-cache.js";
import {
  closePluginWebhookWebsocket,
  handlePluginWebhookWs,
  isPluginWebhookSocketData,
  messagePluginWebhookWebsocket,
  openPluginWebhookWebsocket,
} from "./http/routes/plugin-webhook-websocket.js";
import {
  reconcilePluginWebhookRoutes,
  watchPluginIngressForWebhookRoutes,
} from "./channels/plugin-webhook-route-sync.js";
import { PLUGIN_WEBHOOK_PATH_PATTERN } from "./channels/plugin-ingress.js";
import {
  getLogger,
  initLogger,
  LOG_RETENTION_SWEEP_INTERVAL_MS,
  pruneOldLogFiles,
  type LogFileConfig,
} from "./logger.js";
import {
  bindCloudIdentityCredentialCache,
  ensureCloudIdentityIds,
} from "./cloud-identity.js";
import { buildSchema } from "./schema.js";
import { startDiscordGateway } from "./discord/lifecycle.js";
import { startSlackGateway } from "./slack/lifecycle.js";
import { checkAuthRateLimit } from "./http/middleware/rate-limit.js";
import {
  extractBearerToken,
  isHttpAuthDisabled,
  logAuthBypassState,
} from "./http/middleware/auth.js";
import {
  resolveExtensionOrigin,
  handleExtensionPreflight,
  withExtensionCorsHeaders,
  resolveWebviewOrigin,
  handlePreflight,
  withCorsHeaders,
} from "./http/middleware/cors.js";
import { validateEdgeToken } from "./auth/token-exchange.js";
import { createRouter, type GetClientIp } from "./http/router.js";
import { ROUTES, webhookDedupCaches } from "./http/routes/index.js";
import { startSleepWakeDetector } from "./sleep-wake-detector.js";
import { startIpcServer } from "./ipc/server.js";
import { refreshRouteSchema } from "./ipc/route-schema-cache.js";
import { initGatewayDb } from "./db/connection.js";
import { startTunnelClient } from "./tunnel/lifecycle.js";
import { runPostAssistantReady } from "./post-assistant-ready.js";
import {
  APP_VERSION,
  VERSION_HEADER_NAME,
  VERSION_HEADER_VALUE,
} from "./version.js";
import { isWebsocketUpgradeRequest } from "./http/utils.js";
import { startInboundEventExpirationCleanup } from "./channels/inbound-event.js";
process.title = "cadet-gateway";

const log = getLogger("main");

function generateTraceId(): string {
  return randomBytes(8).toString("hex");
}

let draining = false;
let postAssistantReadyComplete = false;

/**
 * Detect which services had credential changes and log them.
 * Returns the set of service names that changed so callers can
 * trigger side effects (e.g. Telegram webhook reconciliation,
 * Slack socket restart).
 */
// Shared rate limiter for auth failures and unauthenticated endpoints
const authRateLimiter = getAuthRateLimiter();

/** Log-safe socket-type discriminant for unknown-socket diagnostics. */
function extractWsType(data: unknown): unknown {
  return data && typeof data === "object"
    ? (data as { wsType?: unknown }).wsType
    : undefined;
}

function closeUnknownSocket(
  ws: { data: unknown; close(code?: number, reason?: string): void },
  event: "open" | "message",
): void {
  log.error(
    { event, wsType: extractWsType(ws.data) },
    "WebSocket event for unknown socket type — closing",
  );
  ws.close(1011, "Unknown socket type");
}

function getClientIp(
  req: Request,
  server: ReturnType<typeof Bun.serve>,
  trustProxy: boolean,
): string {
  if (trustProxy) {
    const forwarded = req.headers.get("x-forwarded-for");
    if (forwarded) {
      const first = forwarded.split(",")[0].trim();
      if (first) return first;
    }
  }
  const addr = server.requestIP(req);
  return addr?.address ?? "unknown";
}

/**
 * Background log-retention sweep (field feedback item 8): the prune used to
 * run inside initLogger — and on every UTC rollover inside getLogger() —
 * both on hot paths. The gateway main process owns the interval now; a
 * dedicated monitoring worker is the follow-up wiring (out of scope for
 * now). Unref'd so it never holds the process open.
 */
function startLogRetentionSweep(config: LogFileConfig): void {
  if (!config.dir) return;
  const interval = setInterval(() => {
    try {
      const removed = pruneOldLogFiles(config.dir!, config.retentionDays);
      if (removed > 0) {
        log.info(
          { removed, retentionDays: config.retentionDays },
          "Pruned old log files",
        );
      }
    } catch (err) {
      log.warn({ err }, "Log retention sweep failed");
    }
  }, LOG_RETENTION_SWEEP_INTERVAL_MS);
  interval.unref();
}

type StopTask = () => Promise<void> | void;

async function main() {
  const config = loadConfig();
  initLogger(config.logFile);
  startLogRetentionSweep(config.logFile);

  log.info("Starting Cadet Gateway...");

  // Initialize the JWT signing key shared with the daemon.
  // This must happen before any request handling.
  initSigningKey();
  log.info("JWT signing key initialized");

  await initGatewayDb();
  initTrustRuleCache();
  initAdmissionPolicyCache();

  // Plugin rows in the webhook registry are derived from the declarations the
  // ingress gate currently serves, so startup recomputes them from what is
  // installed and approved right now rather than trusting whatever the last
  // run left behind. Anything that moved while the gateway was down settles
  // here, and the watch below keeps them settling while it runs.
  reconcilePluginWebhookRoutes();
  watchPluginIngressForWebhookRoutes();

  // ── TTL caches ──
  // Instantiate caches for credential and config file reads.
  // Handlers read dynamic credentials and config.json values from these
  // caches at call time, with automatic TTL refresh.
  const credentialCache = getCredentials();
  bindCloudIdentityCredentialCache(credentialCache);
  void ensureCloudIdentityIds();
  // Assistant-scoped mirrors of the browser stream sockets: the scoped data
  // plane emits /v1/assistants/<id>/<route> — the same verbatim shape every
  // scoped forwarder carries — so the upgrade pre-router admits the scoped
  // spelling of each socket and discards the id, the same mirror the route
  // table keeps for tunnel/status. Daemon-only sockets (speech relay) get no
  // mirror: they are never browser-reachable.
  const SCOPED_WS_MIRRORS: Array<{
    pattern: RegExp;
    upgrade: (
      req: Request,
      server: Parameters<typeof handleSttStreamWs>[1],
    ) => Promise<Response | undefined> | Response | undefined;
  }> = [
    {
      pattern: /^\/v1\/assistants\/[^/]+\/live-voice\/?$/,
      upgrade: handleLiveVoiceWs,
    },
    {
      pattern: /^\/v1\/assistants\/[^/]+\/stt\/stream\/?$/,
      upgrade: handleSttStreamWs,
    },
    {
      pattern: /^\/v1\/assistants\/[^/]+\/watch\/stream\/?$/,
      upgrade: handleWatchStreamWs,
    },
    {
      pattern: /^\/v1\/assistants\/[^/]+\/desktop\/stream\/?$/,
      upgrade: handleDesktopStreamWs,
    },
  ];
  // ── Route table ──
  // One routes array, owned by the routes barrel: every HTTP route is
  // declared in a per-domain ROUTES array and concatenated there, in
  // dispatch order (the runtime-proxy catch-all last). Routes are matched
  // top-to-bottom; auth middleware is applied declaratively per route.
  const router = createRouter(ROUTES, {
    authRateLimiter,
    trustProxy: config.trustProxy,
  });

  // The webhook dedup caches whose lifecycle (cleanup timers, credential
  // resets) this process manages below.
  const { telegramDedupCache, whatsappDedupCache, emailDedupCache } =
    webhookDedupCaches();

  /** Stamp the assistant version header on a response. */
  function stampVersion<T extends Response>(res: T): T {
    res.headers.set(VERSION_HEADER_NAME, VERSION_HEADER_VALUE);
    return res;
  }

  const server = Bun.serve({
    port: config.port,
    idleTimeout: 0,
    // Match the daemon's 512 MB limit (assistant/src/runtime/http-server.ts)
    // to accommodate large app package uploads.
    maxRequestBodySize: 512 * 1024 * 1024,
    websocket: {
      // Every stream's socket data carries a `wsType` discriminant, and
      // each websocket module owns a zod-parsed `isXSocketData` predicate —
      // the narrowest type discrimination, no casts. A WS route table like
      // the HTTP one below falls out of this shape when a seventh stream
      // makes the if-chain worth a table.
      open(ws) {
        if (isMediaStreamSocketData(ws)) {
          openTwilioMediaWebsocket(ws);
          return;
        }
        if (isPluginWebhookSocketData(ws)) {
          openPluginWebhookWebsocket(ws);
          return;
        }
        if (isSttStreamSocketData(ws)) {
          openSttStreamWebsocket(ws);
          return;
        }
        if (isWatchStreamSocketData(ws)) {
          openWatchStreamWebsocket(ws);
          return;
        }
        if (isDesktopStreamSocketData(ws)) {
          openDesktopStreamWebsocket(ws);
          return;
        }
        if (isLiveVoiceSocketData(ws)) {
          openLiveVoiceWebsocket(ws);
          return;
        }
        if (isSpeechRelaySocketData(ws)) {
          void openSpeechRelayWebsocket(ws);
          return;
        }
        closeUnknownSocket(ws, "open");
      },
      message(ws, message) {
        if (isMediaStreamSocketData(ws)) {
          messageTwilioMediaStream(ws, message);
          return;
        }
        if (isPluginWebhookSocketData(ws)) {
          messagePluginWebhookWebsocket(ws, message);
          return;
        }
        if (isSttStreamSocketData(ws)) {
          messageSttStreamWebsocket(ws, message);
          return;
        }
        if (isWatchStreamSocketData(ws)) {
          messageWatchStreamWebsocket(ws, message);
          return;
        }
        if (isDesktopStreamSocketData(ws)) {
          messageDesktopStreamWebsocket(ws, message);
          return;
        }
        if (isLiveVoiceSocketData(ws)) {
          messageLiveVoiceWebsocket(ws, message);
          return;
        }
        if (isSpeechRelaySocketData(ws)) {
          messageSpeechRelayWebsocket(ws, message);
          return;
        }
        closeUnknownSocket(ws, "message");
      },
      close(ws, code, reason) {
        if (isMediaStreamSocketData(ws)) {
          closeTwilioMediaStream(ws, code, reason);
          return;
        }
        if (isPluginWebhookSocketData(ws)) {
          closePluginWebhookWebsocket(ws, code, reason);
          return;
        }
        if (isSttStreamSocketData(ws)) {
          closeSttStreamWebsocket(ws, code, reason);
          return;
        }
        if (isWatchStreamSocketData(ws)) {
          closeWatchStreamWebsocket(ws, code, reason);
          return;
        }
        if (isDesktopStreamSocketData(ws)) {
          closeDesktopStreamWebsocket(ws, code, reason);
          return;
        }
        if (isLiveVoiceSocketData(ws)) {
          closeLiveVoiceWebsocket(ws, code, reason);
          return;
        }
        if (isSpeechRelaySocketData(ws)) {
          closeSpeechRelayWebsocket(ws, code, reason);
          return;
        }
        log.error(
          { wsType: extractWsType(ws.data), code, reason },
          "WebSocket closed with unknown socket type",
        );
      },
    },
    error(err) {
      if (err instanceof CircuitBreakerOpenError) {
        return stampVersion(
          Response.json(
            {
              error: "Service temporarily unavailable — runtime is unreachable",
            },
            {
              status: 503,
              headers: { "Retry-After": String(err.retryAfterSecs) },
            },
          ),
        );
      }
      log.error({ err }, "Unhandled gateway error");
      return stampVersion(
        Response.json({ error: "Internal server error" }, { status: 500 }),
      );
    },
    async fetch(req, svr) {
      svr.timeout(req, 1800);
      const inner = await routeRequest(req, svr);
      if (inner) stampVersion(inner);
      return inner;
    },
  });

  /** Core request routing — extracted so `fetch` can stamp headers on every response. */
  async function routeRequest(
    req: Request,
    svr: ReturnType<typeof Bun.serve>,
  ): Promise<Response | undefined> {
    const url = new URL(req.url);

    // ── Pre-router: health probe ──
    // This stays available during post-assistant-ready startup work so
    // Kubernetes startup/liveness probes can observe the bound process.
    if (url.pathname === "/healthz") {
      const includeMigrations =
        url.searchParams.get("include") === "migrations";
      if (!includeMigrations) {
        // The probe doubles as the app shell's identity ping: the version it
        // serves, and whether the CALLER's own credentials (the browser
        // access cookie, or a bearer) authenticate. The /v1 routes can serve
        // 200 unauthenticated over loopback trust, so this verdict is the one
        // reliable signal a client has before it mounts an authenticated UI.
        // Probes without credentials (k8s liveness) read authenticated:false —
        // they only look at the status code.
        const token = extractBearerToken(req);
        const authenticated = isHttpAuthDisabled()
          ? true
          : token !== null && validateEdgeToken(token).ok;
        return Response.json({
          status: "ok",
          version: APP_VERSION,
          authenticated,
        });
      }
      // Fetch the daemon's /v1/health to surface migration state
      // (dbVersion, lastWorkspaceMigrationId) so the CLI can capture
      // pre-upgrade migration state through the gateway.
      try {
        const upstream = await fetch(
          `${config.assistantRuntimeBaseUrl}/v1/health`,
          {
            signal: AbortSignal.timeout(3000),
            headers: forwardedIdentityHeaders(),
          },
        );
        if (upstream.ok) {
          const body = (await upstream.json()) as {
            migrations?: {
              dbVersion?: number;
              lastWorkspaceMigrationId?: string;
            };
          };
          return Response.json({
            status: "ok",
            ...(body.migrations ? { migrations: body.migrations } : {}),
          });
        }
      } catch {
        // Daemon unreachable — graceful degradation, still return ok
      }
      return Response.json({ status: "ok" });
    }

    if (url.pathname === "/readyz") {
      if (draining) {
        return Response.json({ status: "draining" }, { status: 503 });
      }
      // Check that the upstream assistant is also reachable so callers
      // know the full stack is ready, not just the gateway process.
      //
      // The assistant's readiness body (`ready`, `dbMigrations`) is forwarded
      // so programmatic callers — the upgrade/hatch CLI waits in particular —
      // can distinguish "still migrating" (200, ready:false) from "ready" and
      // detect terminally failed migrations.
      //
      // Status-code contract while the gateway's own post-assistant-ready
      // work is incomplete (every non-probe route 503s "starting"):
      // - Assistant still migrating (ready:false body): 200. Migrations can
      //   take minutes and the orchestrator must keep the pod in service —
      //   the forwarded ready:false body already keeps body-aware CLI waits
      //   waiting.
      // - Assistant ready, gateway backfills still running: 503 "starting".
      //   This window is seconds long, and reporting ready here would let
      //   the orchestrator route traffic — and CLI waits declare the stack
      //   ready — while every route still 503s (upgrade would commit early;
      //   hatch would burn its guardian-lease budget against the closed
      //   gate).
      try {
        const upstream = await fetch(
          `${config.assistantRuntimeBaseUrl}/readyz`,
          { signal: AbortSignal.timeout(3000) },
        );
        const upstreamBody = (await upstream
          .json()
          .catch(() => null)) as Record<string, unknown> | null;
        if (!upstream.ok) {
          return Response.json(
            {
              ...(upstreamBody ?? {}),
              status: "upstream_unhealthy",
              upstream: upstream.status,
            },
            { status: 503 },
          );
        }
        if (!postAssistantReadyComplete) {
          if (upstreamBody?.ready === false) {
            return Response.json(upstreamBody);
          }
          return Response.json(
            { ...(upstreamBody ?? {}), status: "starting", ready: false },
            { status: 503 },
          );
        }
        return Response.json(upstreamBody ?? { status: "ok" });
      } catch {
        return Response.json(
          { status: "upstream_unreachable" },
          { status: 503 },
        );
      }
    }

    if (!postAssistantReadyComplete) {
      return Response.json({ status: "starting" }, { status: 503 });
    }

    // ── CORS: webview preflight & origin tracking ──
    // The macOS WKWebView loads pages from https://{appId}.cadet.local/
    // which is cross-origin to the gateway at http://127.0.0.1:{port}.
    // Reflect the origin back on matched requests so window.cadet.fetch
    // calls succeed.
    const extensionOrigin = resolveExtensionOrigin(req);
    if (extensionOrigin && req.method === "OPTIONS") {
      return handleExtensionPreflight(extensionOrigin);
    }

    const webviewOrigin = resolveWebviewOrigin(req);
    if (webviewOrigin && req.method === "OPTIONS") {
      return handlePreflight(webviewOrigin);
    }

    if (url.pathname === "/schema") {
      return Response.json(buildSchema());
    }

    // Per-request IP resolver — scoped to this request so it remains
    // correct across async yields under concurrent load.
    const resolveClientIp: GetClientIp = () =>
      getClientIp(req, svr, config.trustProxy);

    const rateLimitResponse = checkAuthRateLimit(
      url,
      authRateLimiter,
      resolveClientIp(),
    );
    if (rateLimitResponse) {
      if (extensionOrigin)
        return withExtensionCorsHeaders(rateLimitResponse, extensionOrigin);
      if (webviewOrigin)
        return withCorsHeaders(rateLimitResponse, webviewOrigin);
      return rateLimitResponse;
    }

    // ── Pre-router: WebSocket upgrades ──
    // Bun's WS upgrade needs `server.upgrade()` which doesn't return
    // a Response, so these can't go through the route table.
    if (
      url.pathname === TWILIO_MEDIA_STREAM_WEBHOOK_PATH ||
      url.pathname.startsWith(`${TWILIO_MEDIA_STREAM_WEBHOOK_PATH}/`)
    ) {
      const upgradeResult = handleTwilioMediaWs(req, server);
      if (upgradeResult !== undefined) return upgradeResult;
      return undefined;
    }

    // Plugin ingress declared as `websocket`. Claimed only for a genuine
    // upgrade — a plain request to the same path stays with the route table,
    // where the HTTP half 404s it for not being an approved HTTP route.
    if (isWebsocketUpgradeRequest(req)) {
      const match = url.pathname.match(PLUGIN_WEBHOOK_PATH_PATTERN);
      if (match) {
        const upgradeResult = await handlePluginWebhookWs(
          req,
          server,
          match[1]!,
          match[2]!,
        );
        if (upgradeResult !== undefined) return upgradeResult;
        return undefined;
      }
    }

    if (isWebsocketUpgradeRequest(req)) {
      for (const mirror of SCOPED_WS_MIRRORS) {
        if (!mirror.pattern.test(url.pathname)) continue;
        const upgradeResult = await mirror.upgrade(req, server);
        if (upgradeResult !== undefined) return upgradeResult;
        return undefined;
      }
    }

    if (url.pathname === "/v1/stt/stream") {
      const upgradeResult = handleSttStreamWs(req, server);
      if (upgradeResult !== undefined) return upgradeResult;
      return undefined;
    }

    // Reachable both ways: directly on a self-hosted ingress with an actor
    // edge JWT, and through the tunnel on a cloud assistant, which is
    // why it is in `TUNNEL_ALLOWED_PATHS`. The handler authorizes each shape on
    // its own terms and admits only the guardian either way. A paired
    // assistant has no transport at all and never reaches here.
    if (url.pathname === "/v1/watch/stream") {
      const upgradeResult = await handleWatchStreamWs(req, server);
      if (upgradeResult !== undefined) {
        return upgradeResult;
      }
      return undefined;
    }

    // Guardian-only through the same gate as the watch stream.
    if (url.pathname === "/v1/desktop/stream") {
      const upgradeResult = await handleDesktopStreamWs(req, server);
      if (upgradeResult !== undefined) {
        return upgradeResult;
      }
      return undefined;
    }

    if (url.pathname === "/v1/live-voice") {
      const upgradeResult = await handleLiveVoiceWs(req, server);
      if (upgradeResult !== undefined) return upgradeResult;
      return undefined;
    }

    // Managed-speech relay: daemon-only egress to tunnel. NOT in
    // TUNNEL_ALLOWED_PATHS — tunnel's inbound tunnel must never reach it.
    if (url.pathname === "/v1/speech/stt/stream") {
      const upgradeResult = await handleSpeechRelaySttWs(req, server);
      if (upgradeResult !== undefined) return upgradeResult;
      return undefined;
    }

    if (url.pathname === "/v2/speech/stt/stream") {
      const upgradeResult = await handleSpeechRelaySttV2Ws(req, server);
      if (upgradeResult !== undefined) return upgradeResult;
      return undefined;
    }

    if (url.pathname === "/v1/speech/tts/stream") {
      const upgradeResult = await handleSpeechRelayTtsWs(req, server);
      if (upgradeResult !== undefined) return upgradeResult;
      return undefined;
    }

    // Attach a trace ID to every non-healthcheck request for
    // end-to-end correlation across webhook -> runtime -> reply.
    if (!req.headers.has("x-trace-id")) {
      req.headers.set("x-trace-id", generateTraceId());
    }

    // ── Route table dispatch ──
    try {
      const response = await router(req, url, resolveClientIp, svr);
      if (response !== null) {
        if (extensionOrigin) {
          return withExtensionCorsHeaders(response, extensionOrigin);
        }
        if (webviewOrigin) {
          return withCorsHeaders(response, webviewOrigin);
        }
        return response;
      }
    } catch (err) {
      // Mirror the error() handler logic while retaining CORS context.
      // Bun's error() callback doesn't receive the request, so thrown
      // errors during webview/extension requests would otherwise lose CORS headers.
      if (!webviewOrigin && !extensionOrigin) throw err;
      if (err instanceof CircuitBreakerOpenError) {
        const body = Response.json(
          {
            error:
              "Service temporarily unavailable \u2014 runtime is unreachable",
          },
          {
            status: 503,
            headers: { "Retry-After": String(err.retryAfterSecs) },
          },
        );
        if (extensionOrigin)
          return withExtensionCorsHeaders(body, extensionOrigin);

        return withCorsHeaders(body, webviewOrigin!);
      }
      log.error({ err }, "Unhandled gateway error");
      const errBody = Response.json(
        { error: "Internal server error" },
        { status: 500 },
      );
      if (extensionOrigin)
        return withExtensionCorsHeaders(errBody, extensionOrigin);
      return withCorsHeaders(errBody, webviewOrigin!);
    }

    const notFound = Response.json(
      { error: "Not found", source: "gateway" },
      { status: 404 },
    );
    if (extensionOrigin)
      return withExtensionCorsHeaders(notFound, extensionOrigin);
    if (webviewOrigin) return withCorsHeaders(notFound, webviewOrigin);
    return notFound;
  }

  void refreshRouteSchema();

  log.info({ port: server.port }, "Gateway HTTP server listening");

  // Complete post-assistant-ready startup work after binding /healthz.
  // All non-health routes stay closed until this returns. When the assistant
  // is not migration-ready within the bounded wait, this still returns (so
  // traffic opens) while the deferred tasks keep retrying in the background —
  // see post-assistant-ready.ts.
  try {
    await runPostAssistantReady();
    postAssistantReadyComplete = true;
  } catch (err) {
    log.error({ err }, "Post-assistant-ready startup work failed");
    server.stop(true);
    process.exit(1);
  }

  logAuthBypassState();

  const tasks: (() => StopTask | Promise<StopTask>)[] = [
    startCredentialWatcher,
    startIpcServer,
    startConfigFileWatcher,
    startSleepWakeDetector,
    startInboundEventExpirationCleanup,
    () => {
      telegramDedupCache.startCleanup();
      return () => telegramDedupCache.stopCleanup();
    },
    () => {
      whatsappDedupCache.startCleanup();
      return () => whatsappDedupCache.stopCleanup();
    },
    () => {
      emailDedupCache.startCleanup();
      return () => emailDedupCache.stopCleanup();
    },
    startSlackGateway,
    startDiscordGateway,
    startTunnelClient,
  ];
  const shutdownTasks: StopTask[] = await Promise.all(
    tasks.map((task) => task()),
  );

  process.on("SIGTERM", () => {
    log.info("SIGTERM received, starting graceful shutdown");
    draining = true;
    const shutdownPromises = shutdownTasks.map((stopTask) => stopTask());
    setTimeout(() => {
      log.info("Drain window elapsed, stopping server");
      void Promise.allSettled(shutdownPromises).then(() => {
        server.stop(true);
        process.exit(0);
      });
    }, 5_000);
  });
}

main();
