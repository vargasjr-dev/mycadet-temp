import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type { Plugin, Connect, ViteDevServer } from "vite";

import {
  resolveLocalConfigFromEnv,
  isLoopbackAddr,
  headerHostIsLoopback,
  originIsAllowed,
  hasSameOriginCredentialProof,
  readLockfile,
  servedConfigFromLockfile,
  matchOperatorRequest,
  getGuardianAccessToken,
  loopbackGatewayBearer,
  resolveGatewayProxyTarget,
  readGatewayTargets,
  authorizePairedForwardHeaders,
} from "@mycadet/local-mode";
import { stampedVersion } from "@mycadet/shared/version";
import cliPkg from "../../cli/package.json";

// The local host's own routes live at the conductor's /v1 shapes: pairing
// under the gateway's remote-web namespace, device management at the
// gateway's devices routes, and the dev session store at /v1/session. The
// dev server hosts no assistants — every scoped assistant route forwards
// through the id-keyed gateway proxy below, whatever the entry's remote.
const CLOUD_SESSION_PATTERN = /^\/v1\/session$/;

function requestPathname(req: http.IncomingMessage): string {
  return (req.url ?? "").split("?")[0]!;
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
      server.middlewares.use(operatorMiddleware());
      server.middlewares.use(gatewayProxyMiddleware(env));
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

/**
 * The operator routes: the host-served local-mode operations the dev server
 * answers in-process — the headless lifecycle cores (retire/sleep/wake), the
 * lockfile read, hatch, unpair, the pairing exchange, and device management.
 * The match is pure in the URL — the hot path of every other request never
 * touches the lockfile — and the same-origin guard fronts the EXECUTION: a
 * cross-origin retire DELETE is refused here, never executed, never
 * forwarded. The dispatch is the package's shared table directly — match,
 * then `match.route.run` with the caller's own headers and the assistant id
 * (the Electron `app://` handler rides the `forwardOperatorRequest`
 * wrapper of the same seam, so the mounts cannot drift). A pass
 * (unknown id, platform-hosted entry) falls through to the gateway proxy,
 * whose cloud forward keeps the bundle's one endpoint holding for every
 * entry type.
 */
function operatorMiddleware(): Connect.NextHandleFunction {
  return (req, res, next) => {
    const match = matchOperatorRequest(requestPathname(req), req.method);
    if (!match) {
      return next();
    }

    if (rejectUnlessLocalEndpointRequest(req, res)) {
      return;
    }

    // The route rows read the JSON body off the body stream (pairing,
    // devices, hatch, upgrade); the body rides as a lazy stream so a row
    // that PASSES (unknown id) leaves the request stream untouched for the
    // gateway proxy's forward. GET/HEAD cannot carry a body — only other
    // methods attach one. The caller's own headers ride along (the
    // resolution forwards them upstream so the gateway judges the browser).
    const hasBody = !["GET", "HEAD"].includes(req.method ?? "GET");
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) {
        continue;
      }
      for (const v of Array.isArray(value) ? value : [value]) {
        headers.append(key, v);
      }
    }
    void match.route
      .run({
        assistantId: match.assistantId,
        headers,
        ...(hasBody
          ? { body: Readable.toWeb(req) as unknown as ReadableStream }
          : {}),
      })
      .then((response) => {
        if (!response) {
          return next();
        }
        res.statusCode = response.status;
        const contentType = response.headers.get("content-type");
        if (contentType) {
          res.setHeader("Content-Type", contentType);
        }
        if (response.status === 204) {
          res.end();
          return;
        }
        void response.text().then((body) => res.end(body));
      })
      .catch(() => {
        if (!res.headersSent) {
          respondJson(res, 500, { detail: "Operator request failed" });
        }
      });
  };
}

function gatewayProxyMiddleware(
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
      const lease = () => getGuardianAccessToken(decision.assistantId);
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
      getGuardianAccessToken,
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
