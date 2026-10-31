import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import type { Plugin, Connect, ViteDevServer } from "vite";

import {
  resolveLocalConfigFromEnv,
  resolveDevCliInvocation,
  isLoopbackAddr,
  headerHostIsLoopback,
  originIsAllowed,
  hasSameOriginCredentialProof,
  readLockfile,
  servedConfigFromLockfile,
  stripSensitiveFields,
  runDevicesList,
  runDevicesRevoke,
  pairingCancel,
  pairingPoll,
  pairingStart,
  unpairAssistant,
  getGuardianAccessToken,
  loopbackGatewayBearer,
  resolveGatewayProxyTarget,
  readGatewayTargets,
  authorizePairedForwardHeaders,
  type CliInvocation,
} from "@mycadet/local-mode";
import { stampedVersion } from "@mycadet/shared/version";
import cliPkg from "../../cli/package.json";

// The local host's own routes live at the conductor's /v1 shapes: pairing
// under the gateway's remote-web namespace, device management at the
// gateway's devices routes, and the dev session store at /v1/session. The
// dev server hosts no assistants — every scoped assistant route forwards
// through the id-keyed gateway proxy below, whatever the entry's remote.
const LOCAL_UNPAIR_PATTERN = /^\/v1\/assistants\/([^/]+)\/unpair\/?$/;
const CLOUD_SESSION_PATTERN = /^\/v1\/session$/;

function requestPathname(req: http.IncomingMessage): string {
  return (req.url ?? "").split("?")[0]!;
}

function lockfileEntryFor(assistantId: string) {
  return readLockfile().assistants.find((a) => a.assistantId === assistantId);
}

// In-memory loopback cloud session token for the dev server. The proxy
// (vite.config.ts) and the middleware below run in the same Node process, so
// this module singleton bridges them. Dev-only and session-scoped; the
// installed CLI persists the token via its own store.
let devCloudSessionToken: string | null = null;
export function getDevCloudSessionToken(): string | null {
  return devCloudSessionToken;
}

/**
 * Whether a proxied request is same-origin SPA traffic that may carry a
 * host-owned credential. A cross-origin page must not be able to use the dev
 * proxy as a confused deputy. Mirrors the Bun server's check.
 */
export function isSameOriginProxyRequest(req: http.IncomingMessage): boolean {
  const host = Array.isArray(req.headers.host)
    ? req.headers.host[0]
    : req.headers.host;
  const origin = Array.isArray(req.headers.origin)
    ? req.headers.origin[0]
    : req.headers.origin;
  const site = req.headers["sec-fetch-site"];
  const siteValue = Array.isArray(site) ? site[0] : site;
  return hasSameOriginCredentialProof(host, origin, siteValue);
}

export function localModePlugin(env: Record<string, string>): Plugin {
  const config = resolveLocalConfigFromEnv();
  const baseDir = path.resolve(import.meta.dirname, "..", "..");

  const configJson = JSON.stringify({
    cloudUrl: config.cloudUrl,
    version: stampedVersion(cliPkg.version),
    ...servedConfigFromLockfile(readLockfile()),
  }).replace(/</g, "\\u003c");

  return {
    name: "cadet-local-mode",
    transformIndexHtml(html) {
      return html.replace(
        "</head>",
        `<script>window.__CADET_CONFIG__=${configJson}</script></head>`,
      );
    },
    configureServer(server) {
      server.middlewares.use(loopbackCallbackMiddleware());
      server.middlewares.use(cloudSessionMiddleware());
      server.middlewares.use(configMiddleware(configJson));
      server.middlewares.use(lockfileMiddleware());
      server.middlewares.use(unpairMiddleware());
      server.middlewares.use(pairingMiddleware());
      server.middlewares.use(devicesMiddleware(baseDir));
      server.middlewares.use(gatewayProxyMiddleware(baseDir, env));
      server.middlewares.use(accountSpaFallback(server));
    },
  };
}

function respondJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

/**
 * Buffer and parse a JSON request body. An empty body resolves to `{}` (the
 * per-field validation reports what's missing); malformed JSON resolves to
 * `null`.
 */
function readJsonBody(
  req: http.IncomingMessage,
): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(
          JSON.parse(Buffer.concat(chunks).toString()) as Record<
            string,
            unknown
          >,
        );
      } catch {
        resolve(null);
      }
    });
  });
}

function rejectUnlessLocalEndpointRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  const peer = req.socket.remoteAddress ?? "";
  const host = Array.isArray(req.headers.host)
    ? req.headers.host[0]
    : req.headers.host;
  const origin = Array.isArray(req.headers.origin)
    ? req.headers.origin[0]
    : req.headers.origin;
  if (
    !isLoopbackAddr(peer) ||
    !headerHostIsLoopback(host) ||
    !originIsAllowed(origin)
  ) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Forbidden" }));
    return true;
  }
  return false;
}

function loopbackCallbackMiddleware(): Connect.NextHandleFunction {
  return (req, res, next) => {
    if (req.url?.startsWith("/callback")) {
      const qs = req.url.slice("/callback".length);
      res.writeHead(302, { Location: `/account/cloud-callback${qs}` });
      res.end();
      return;
    }
    next();
  };
}

// Receives the loopback platform session token from the SPA (after it has
// validated the `state` nonce) and holds it for the proxy. Mirrors the Bun
// server's /__local/cloud-session endpoint.
function cloudSessionMiddleware(): Connect.NextHandleFunction {
  return (req, res, next) => {
    const path = (req.url ?? "").split("?")[0];
    if (!CLOUD_SESSION_PATTERN.test(path)) {
      return next();
    }
    if (rejectUnlessLocalEndpointRequest(req, res)) {
      return;
    }

    if (req.method === "DELETE") {
      devCloudSessionToken = null;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end();
      return;
    }

    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let token: unknown;
      try {
        token = (
          JSON.parse(Buffer.concat(chunks).toString()) as { token?: unknown }
        ).token;
      } catch {
        token = undefined;
      }
      if (typeof token !== "string" || !/^[A-Za-z0-9]+$/.test(token)) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: false, error: "Invalid token" }));
        return;
      }
      devCloudSessionToken = token;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
  };
}

function configMiddleware(configJson: string): Connect.NextHandleFunction {
  return (req, res, next) => {
    if (req.url !== "/assistant/__config" && req.url !== "/__config") {
      return next();
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(configJson);
  };
}

function accountSpaFallback(server: ViteDevServer): Connect.NextHandleFunction {
  return (req, res, next) => {
    if (
      !req.url?.startsWith("/account/") &&
      !req.url?.startsWith("/account?") &&
      req.url !== "/account"
    ) {
      return next();
    }

    const indexPath = path.join(server.config.root, "index.html");
    fs.readFile(indexPath, "utf-8", (err, html) => {
      if (err) {
        return next(err);
      }
      server
        .transformIndexHtml(req.url!, html)
        .then((transformed) => {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(transformed);
        })
        .catch(next);
    });
  };
}

function lockfileMiddleware(): Connect.NextHandleFunction {
  return (req, res, next) => {
    // Bare `/v1/assistants/` only: the SDK's list request (query-carrying)
    // passes through to the dev `/v1` proxy and the conductor's list route.
    if (requestPathname(req) !== "/v1/assistants/") {
      return next();
    }

    if (rejectUnlessLocalEndpointRequest(req, res)) {
      return;
    }

    // Read-only: the local-mode commands own lockfile writes now (the
    // desktop bridge's write verbs are gone with them).
    if (req.method === "GET") {
      res.setHeader("Content-Type", "application/json");
      const lockfile = readLockfile();
      stripSensitiveFields(lockfile);
      res.end(JSON.stringify(lockfile));
    } else {
      res.statusCode = 405;
      res.end();
    }
  };
}

function unpairMiddleware(): Connect.NextHandleFunction {
  return (req, res, next) => {
    const match = requestPathname(req).match(LOCAL_UNPAIR_PATTERN);
    if (!match) {
      return next();
    }

    if (rejectUnlessLocalEndpointRequest(req, res)) {
      return;
    }

    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end();
      return;
    }

    const assistantId = decodeURIComponent(match[1]!);
    if (lockfileEntryFor(assistantId) == null) {
      // Not an entry on this machine — the id-keyed proxy resolves the rest
      // (the conductor's routes for a cloud id).
      return next();
    }

    const result = unpairAssistant(assistantId);
    respondJson(
      res,
      result.ok ? 200 : result.status,
      result.ok
        ? { ok: true, lockfile: result.lockfile }
        : { ok: false, error: result.error },
    );
  };
}

/** The three pairing routes, under the gateway's remote-web namespace. */
const PAIRING_ROUTES = ["pairing-start", "pairing-poll", "pairing-cancel"];

function pairingRoute(url: string | undefined): string | null {
  const path = (url ?? "").split("?")[0];
  for (const route of PAIRING_ROUTES) {
    if (path === `/v1/remote-web/${route}`) {
      return route;
    }
  }
  return null;
}

/**
 * The device-code exchange that registers an assistant paired on another
 * machine: start an attempt from a pasted address, poll it until the host
 * approves, cancel it on the way out. It runs here rather than in the browser,
 * so the device code and the credentials it buys never reach the renderer.
 */
function pairingMiddleware(): Connect.NextHandleFunction {
  return (req, res, next) => {
    const route = pairingRoute(req.url);
    if (route === null) {
      return next();
    }

    if (rejectUnlessLocalEndpointRequest(req, res)) {
      return;
    }

    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end();
      return;
    }

    void readJsonBody(req).then(async (body) => {
      if (!body) {
        respondJson(res, 400, { ok: false, error: "Invalid JSON body" });
        return;
      }

      if (route === "pairing-cancel") {
        respondJson(res, 200, { ok: pairingCancel(body.handle) });
        return;
      }

      if (route === "pairing-start") {
        const result = await pairingStart(body.address);
        respondJson(
          res,
          result.ok ? 200 : result.status,
          result.ok
            ? {
                ok: true,
                handle: result.handle,
                userCode: result.userCode,
                expiresAt: result.expiresAt,
                intervalSeconds: result.intervalSeconds,
              }
            : // `rejection` rides along so the renderer can show its own
              // localized copy for a refused address instead of this host's
              // English.
              {
                ok: false,
                reason: result.reason,
                error: result.error,
                rejection: result.rejection,
              },
        );
        return;
      }

      const result = await pairingPoll({
        handle: body.handle,
        name: body.name,
      });
      if (!result.ok) {
        respondJson(res, result.status, {
          ok: false,
          reason: result.reason,
          error: result.error,
        });
        return;
      }
      if (result.status === "pending") {
        respondJson(res, 200, {
          ok: true,
          status: "pending",
          expiresAt: result.expiresAt,
          intervalSeconds: result.intervalSeconds,
        });
        return;
      }
      // Pairing never defines or saves a lockfile entry — imports create
      // entries; pairs pair with a defined one. The exchange's identity facts
      // go back to the page; creating the entry is the import's burden.
      respondJson(res, 200, {
        ok: true,
        status: "imported",
        assistantId: result.assistantId,
        accessOnly: result.accessOnly,
      });
    });
  };
}

// Paired-device management via the CLI (`cadet devices … --json`). POST-only
// (the renderer's postLocalCommand always POSTs); run-helper results respond
// 200 with `ok` discriminating success so all hosts share one wire shape.
function devicesMiddleware(baseDir: string): Connect.NextHandleFunction {
  return (req, res, next) => {
    const isRevoke = requestPathname(req) === "/v1/devices/revoke";
    if (!isRevoke && requestPathname(req) !== "/v1/devices") {
      return next();
    }

    if (rejectUnlessLocalEndpointRequest(req, res)) {
      return;
    }

    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end();
      return;
    }

    void readJsonBody(req).then((body) => {
      if (!body) {
        respondJson(res, 400, { ok: false, error: "Invalid JSON body" });
        return;
      }

      const assistantId = body.assistantId;
      if (typeof assistantId !== "string" || !assistantId) {
        respondJson(res, 400, { ok: false, error: "Missing assistantId" });
        return;
      }

      let revokeHash: string | null = null;
      if (isRevoke) {
        const hashedDeviceId = body.hashedDeviceId;
        if (typeof hashedDeviceId !== "string" || !hashedDeviceId) {
          respondJson(res, 400, { ok: false, error: "Missing hashedDeviceId" });
          return;
        }
        revokeHash = hashedDeviceId;
      }

      let invocation: CliInvocation;
      try {
        invocation = resolveDevCliInvocation(baseDir, import.meta.url);
      } catch (err) {
        respondJson(res, 500, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      if (revokeHash !== null) {
        void runDevicesRevoke(invocation, assistantId, revokeHash).then(
          (result) => {
            respondJson(res, 200, result);
          },
        );
        return;
      }
      void runDevicesList(invocation, assistantId).then((result) => {
        respondJson(res, 200, result);
      });
    });
  };
}

function gatewayProxyMiddleware(
  baseDir: string,
  env: Record<string, string>,
): Connect.NextHandleFunction {
  return (req, res, next) => {
    // Gateway data plane. The scoped SDK surface (`/v1/assistants/{id}/*`)
    // rides one id-keyed proxy for every assistant gateway. The lockfile
    // resolves the id to a loopback port (locally hatched) or the recorded
    // gateway address of a custom remote (imported pairing) — that target
    // map is the allowlist.
    // The host OWNS the Authorization header: it overwrites whatever the
    // renderer sent with the bearer it mints from the on-disk guardian
    // token (401 re-mint retry on bodyless requests); remote hops
    // sanitize browser-ambient headers and install the paired guardian
    // bearer. An unknown id on the scoped surface passes through to the
    // dev `/v1` proxy (the cloud), so cloud assistants keep their
    // platform-served routes.
    const decision = resolveGatewayProxyTarget(req.url ?? "", () =>
      readGatewayTargets(),
    );
    if (decision.kind === "pass") {
      return next();
    }

    if (rejectUnlessLocalEndpointRequest(req, res)) {
      return;
    }

    if (decision.kind === "reject") {
      res.statusCode = decision.status;
      res.end(decision.message);
      return;
    }

    if (decision.target.kind === "loopback") {
      const { port } = decision.target;
      // The trusted dev-server host owns the Authorization header: it
      // overwrites whatever the renderer sent with the bearer it mints
      // from the on-disk guardian token — the browser never holds one.
      const lease = async () => {
        const invocation = resolveDevCliInvocation(baseDir, import.meta.url);
        return getGuardianAccessToken(decision.assistantId, invocation);
      };
      const mint =
        decision.path !== "/auth/token"
          ? loopbackGatewayBearer(port, lease)
          : Promise.resolve(null);
      mint
        .then((bearer) => {
          pipeGatewayProxyWithBearerRetry(
            req,
            res,
            http,
            {
              hostname: "127.0.0.1",
              port,
              path: decision.path + decision.search,
              method: req.method,
              headers: { ...req.headers, host: `127.0.0.1:${port}` },
            },
            bearer,
            () => loopbackGatewayBearer(port, lease, { forceMint: true }),
          );
        })
        .catch(() => {
          if (!res.headersSent) {
            res.statusCode = 502;
            res.end("Gateway proxy error");
          }
        });
      return;
    }

    if (!isSameOriginProxyRequest(req)) {
      res.statusCode = 403;
      res.end("Forbidden");
      return;
    }

    let invocation: CliInvocation;
    try {
      invocation = resolveDevCliInvocation(baseDir, import.meta.url);
    } catch (err) {
      res.statusCode = 500;
      res.end(err instanceof Error ? err.message : String(err));
      return;
    }

    const target = new URL(decision.target.runtimeUrl);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) {
        continue;
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          headers.append(name, item);
        }
      } else {
        headers.set(name, value);
      }
    }
    void authorizePairedForwardHeaders(
      decision.assistantId,
      headers,
      (assistantId) => getGuardianAccessToken(assistantId, invocation),
    ).then((result) => {
      if (!result.ok) {
        res.statusCode = result.status;
        res.end(result.error);
        return;
      }
      headers.set("host", target.host);
      pipeGatewayProxy(
        req,
        res,
        target.protocol === "https:" ? https : http,
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || undefined,
          path: decision.path + decision.search,
          method: req.method,
          headers: Object.fromEntries(headers.entries()),
        },
        "Paired gateway proxy error",
      );
    });
  };
}

// One streamed hop for both gateway data-plane proxies. Drops the upstream's
// `transfer-encoding` before re-emitting: Node's http server sets its own when
// we pipe the streamed body, so copying the gateway's `chunked` too yields a
// duplicate ("too many transfer encodings"). A strict downstream proxy (the
// `vel up` Caddy edge) rejects that with 502, fatal for the SSE `/events`
// stream, whose failure drives a client reconnect + full-refetch loop.
function pipeGatewayProxy(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  transport: Pick<typeof http, "request">,
  options: http.RequestOptions,
  errorMessage: string,
): void {
  const proxyReq = transport.request(options, (proxyRes) => {
    const headers = { ...proxyRes.headers };
    delete headers["transfer-encoding"];
    res.writeHead(proxyRes.statusCode ?? 502, headers);
    proxyRes.pipe(res);
  });

  proxyReq.on("error", () => {
    if (!res.headersSent) {
      res.statusCode = 502;
      res.end(errorMessage);
    }
  });

  req.pipe(proxyReq);
}

/**
 * The loopback variant of {@link pipeGatewayProxy} with bearer-custody
 * retry: when the gateway rejects the injected bearer with a 401 on a
 * bodyless request, the rejected upstream response is discarded, the host
 * re-mints once, and the request is sent again — a revoked bearer heals on
 * the next request instead of 401ing until the cache expires. Bodied
 * requests cannot replay (the request stream is already consumed), so
 * their 401 pipes through untouched.
 */
function pipeGatewayProxyWithBearerRetry(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  transport: Pick<typeof http, "request">,
  options: http.RequestOptions,
  injectedBearer: string | null,
  reMint: () => Promise<string | null>,
): void {
  const send = (bearer: string | null, isRetry: boolean) => {
    // The host owns the Authorization header on every attempt: overwrite
    // the renderer's value with the current bearer, clear when none
    // applies — a stale credential never rides a retry.
    const headers: http.OutgoingHttpHeaders = { ...options.headers };
    if (bearer) {
      headers.authorization = `Bearer ${bearer}`;
    } else {
      delete headers.authorization;
    }
    const proxyReq = transport.request({ ...options, headers }, (proxyRes) => {
      if (!isRetry && injectedBearer !== null && proxyRes.statusCode === 401) {
        proxyRes.resume();
        void reMint().then((fresh) => {
          if (fresh) {
            send(fresh, true);
            return;
          }
          // The re-mint failed: surface the original rejection.
          const headers = { ...proxyRes.headers };
          delete headers["transfer-encoding"];
          res.writeHead(proxyRes.statusCode ?? 502, headers);
          res.end();
        });
        return;
      }
      const headers = { ...proxyRes.headers };
      delete headers["transfer-encoding"];
      res.writeHead(proxyRes.statusCode ?? 502, headers);
      proxyRes.pipe(res);
    });

    proxyReq.on("error", () => {
      if (!res.headersSent) {
        res.statusCode = 502;
        res.end("Gateway proxy error");
      }
    });

    req.pipe(proxyReq);
  };
  send(injectedBearer, false);
}
