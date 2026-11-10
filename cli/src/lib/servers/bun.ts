/**
 * The App Server powered by Bun
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { GATEWAY_TUNNEL_LOST_WS_CLOSE_CODE } from "@mycadet/service-contracts/ingress";

import {
  matchOperatorRequest,
  servedAssistantFromLockfile,
  servedConfigFromLockfile,
  readLockfile,
} from "@mycadet/local-mode";
import { getGatewayUrl } from "@mycadet/local-mode/contract";

import {
  appOrigins,
  getAppServerPaths,
  readAppServerState,
  type AppServerSpec,
} from "./common.js";

const GZIP_TYPES = new Set([
  "application/javascript",
  "application/json",
  "application/wasm",
  "image/svg+xml",
  "text/css",
  "text/html",
  "text/plain",
]);

function etagFor(text: string): string {
  return `"${createHash("sha256").update(text).digest("hex").slice(0, 24)}"`;
}

function acceptsGzip(request: Request): boolean {
  return /gzip/.test(request.headers.get("accept-encoding") ?? "");
}

/** Serve text (or a file body) with the static tier's cache + gzip posture. */
async function staticResponse(
  request: Request,
  body: { text: string; type: string } | { file: string },
  cacheControl: string,
  transform?: (content: string) => string,
): Promise<Response> {
  const headers = new Headers({ "Cache-Control": cacheControl });
  if ("text" in body) {
    headers.set("Content-Type", body.type);
    if (acceptsGzip(request) && GZIP_TYPES.has(body.type)) {
      headers.set("Content-Encoding", "gzip");
      const stream = new Blob([body.text])
        .stream()
        .pipeThrough(new CompressionStream("gzip"));
      return new Response(stream, { headers });
    }
    headers.set("ETag", etagFor(body.text));
    const noneMatch = request.headers.get("if-none-match");
    if (noneMatch && noneMatch === headers.get("ETag")) {
      return new Response(null, { status: 304, headers });
    }
    const text = transform ? transform(body.text) : body.text;
    return new Response(text, { headers });
  }
  const file = Bun.file(body.file);
  if (!(await file.exists())) {
    return new Response(null, { status: 404 });
  }
  const type = file.type;
  if (type) headers.set("Content-Type", type);
  // Text documents served from disk get the same validator and gzip
  // posture as the inline ones (the injected indexes are the win; the
  // dist's own chunks are pre-gzipped by the build and excluded by type).
  // Bun's file types carry charset parameters ("text/html;charset=utf-8"),
  // so the gzip check reads the base type.
  const baseType = type?.split(";")[0]?.trim();
  if (baseType && GZIP_TYPES.has(baseType)) {
    // The request-time config injection transforms the document BEFORE the
    // validator is computed (the etag fingerprints the served bytes) and
    // before the gzip decision, so the injected document ships on both the
    // compressed and the identity path.
    const rawText = await file.text();
    const text = transform ? transform(rawText) : rawText;
    headers.set("ETag", etagFor(text));
    const noneMatch = request.headers.get("if-none-match");
    if (noneMatch && noneMatch === headers.get("ETag")) {
      return new Response(null, { status: 304, headers });
    }
    if (acceptsGzip(request)) {
      headers.set("Content-Encoding", "gzip");
      const stream = new Blob([text])
        .stream()
        .pipeThrough(new CompressionStream("gzip"));
      return new Response(stream, { headers });
    }
    return new Response(text, { headers });
  }
  return new Response(file, { headers });
}

function notFound(): Response {
  return new Response(null, { status: 404 });
}

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { Location: location } });
}

/**
 * Attach the app-origin CORS treatment to an operator response: reads from
 * the allowlisted shells and hub get the browser's blessing; everything else
 * stays same-origin-governed.
 */
function withAppOriginCors(
  response: Response,
  request: Request,
  allowedOrigins: string[],
): Response {
  const origin = request.headers.get("origin");
  if (!origin || !allowedOrigins.includes(origin)) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Credentials", "true");
  headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Accept, Cadet-Organization-Id");
  headers.append("Vary", "Origin");
  return new Response(response.body, {
    status: response.status,
    headers,
  });
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * The edge-observed client address: the TLS front records the real client as
 * the RIGHTMOST X-Forwarded-For entry (tunnel providers append one;
 * tailscale serve sets it), which the remote client cannot control. Fall
 * back to the raw peer when the front sets no X-Forwarded-For.
 */
function edgeClientIp(request: Request, peer: string | null): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const entries = xff.split(",").map((entry) => entry.trim());
    const last = entries[entries.length - 1];
    if (last) return last;
  }
  return peer ?? "127.0.0.1";
}

/**
 * The serve-time config stamp, read from the LIVE lockfile per request:
 * renaming or re-pointing the served assistant reaches every document the
 * edge hands out, with no restart. Every web-bundle document carries it —
 * the exact mount, the mount's SPA fallback, and the bundle's own index
 * under its baked base — so wherever the bundle boots from, its resolved
 * assistant is already stamped. (The app shell document deliberately stays
 * bare: the shell reads its origin instead.)
 */
/** The live-lockfile config as JSON, `<` escaped for inline script use. */
function servedConfigJson(): string {
  return JSON.stringify(servedConfigFromLockfile(readLockfile())).replace(
    /</g,
    "\\u003c",
  );
}

function configScriptTag(): string {
  return `<script>window.__CADET_CONFIG__=${servedConfigJson()}</script>`;
}

function injectConfig(html: string): string {
  return html.replace("</head>", `${configScriptTag()}</head>`);
}

/**
 * The static SPA surface, ported from the nginx location map: the web
 * bundle's iframe mount at /web/assistant/ (injected index, inline config,
 * SPA fallback), the web bundle's own files under its baked /assistant/
 * build base (hashed assets immutable), the app shell at the origin root
 * (injected document, SPA routes, immutable assets), and the root files the
 * shell ships beside itself. `internal` locations 404 direct hits, and the
 * root files follow try_files: a real file wins, a miss falls back to the
 * app shell document.
 */
async function serveStatic(
  request: Request,
  spec: AppServerSpec,
): Promise<Response | null> {
  const pathname = new URL(request.url).pathname;

  // The web SPA's iframe mount: exact rewrites to the injected document,
  // the inline config, then the dist's own files with the document as the
  // SPA fallback.
  if (pathname === "/web") return redirect("/web/assistant/");
  if (
    pathname === "/web/assistant" ||
    pathname === "/web/assistant/" ||
    pathname === "/web/assistant/index.html"
  ) {
    return staticResponse(
      request,
      { file: spec.indexHtmlPath },
      "no-cache",
      injectConfig,
    );
  }
  if (pathname === "/web/assistant/__config") {
    return staticResponse(
      request,
      { text: servedConfigJson(), type: "application/json" },
      "no-store",
    );
  }
  if (pathname.startsWith("/web/assistant/")) {
    const file = join(
      spec.webDistDir,
      pathname.slice("/web/assistant/".length),
    );
    if (await Bun.file(file).exists()) {
      return staticResponse(request, { file }, "no-cache");
    }
    // A deep route (or a reload of one) boots the bundle from the fallback
    // document — it gets the config stamp like the exact mount paths.
    return staticResponse(request, { file: spec.indexHtmlPath }, "no-cache", injectConfig);
  }

  // The web bundle's baked base at the origin root: /assistant/ serves the
  // web bundle's own files — its hashed assets immutably, the rest
  // no-cache — with the app shell's document as the fallback (the shell
  // owns the /assistant/* host routes).
  if (pathname === "/assistant" || pathname === "/assistant/") {
    return staticResponse(request, { file: spec.appIndexHtmlPath }, "no-cache");
  }
  if (pathname.startsWith("/assistant/assets/")) {
    return staticResponse(
      request,
      {
        file: join(
          spec.webDistDir,
          "assets",
          pathname.slice("/assistant/assets/".length),
        ),
      },
      "public, max-age=31536000, immutable",
    );
  }
  if (pathname.startsWith("/assistant/")) {
    const file = join(spec.webDistDir, pathname.slice("/assistant/".length));
    if (await Bun.file(file).exists()) {
      // The web bundle's own index under its baked base boots the bundle
      // too — it carries the same config stamp as the mount's documents.
      if (pathname === "/assistant/index.html") {
        return staticResponse(request, { file }, "no-cache", injectConfig);
      }
      return staticResponse(request, { file }, "no-cache");
    }
    return staticResponse(request, { file: spec.appIndexHtmlPath }, "no-cache");
  }

  // The app shell: its document is the config-injected standalone index,
  // and every shell route (/, /account/*, /logout) resolves through the SPA
  // fallback. Its own assets and the shipped root files are plain files.
  if (pathname === "/") {
    return staticResponse(request, { file: spec.appIndexHtmlPath }, "no-cache");
  }
  if (pathname.startsWith("/assets/")) {
    return staticResponse(
      request,
      { file: join(spec.appDistDir, pathname.slice(1)) },
      "public, max-age=31536000, immutable",
    );
  }
  if (
    pathname.startsWith("/account") ||
    pathname === "/logout" ||
    pathname.startsWith("/logout/") ||
    pathname === "/index.html" ||
    pathname === "/favicon.svg" ||
    pathname === "/cadet-logo-white.svg" ||
    pathname === "/cadet-scene-cut.mp4"
  ) {
    const file = join(spec.appDistDir, pathname.slice(1));
    if (pathname !== "/account" && (await Bun.file(file).exists())) {
      return staticResponse(request, { file }, "no-cache");
    }
    return staticResponse(request, { file: spec.appIndexHtmlPath }, "no-cache");
  }

  return null;
}

/** The slice of Bun's server handle the handler consumes. */
type AppServerHandle = {
  requestIP: (request: Request) => { address: string } | null;
  upgrade: (request: Request, options: { data: RelayData }) => boolean;
};

/**
 * The app server's one fetch handler. Priority order mirrors the nginx map:
 * the denylist (never edge-reachable), the operator dispatch (the rows are
 * the authority; a pass falls through), the static SPA surface, and the
 * streaming gateway proxy for everything else. `requestIP` is threaded in
 * because Bun exposes the peer address off the server handle, not the
 * Request; handler-level tests omit it.
 */
export function createAppServerHandler(
  spec: AppServerSpec,
): (request: Request, server?: AppServerHandle) => Promise<Response> {
  const allowedOrigins = appOrigins();
  return async function fetch(request, server) {
    const pathname = new URL(request.url).pathname;

    if (pathname === "/healthz")
      return new Response(JSON.stringify({ ok: true }), { status: 200 });

    console.log(
      `[${new Date().toISOString()}] [${request.method}] ${pathname}`,
    );

    if ((request.headers.get("upgrade") ?? "") !== "" && server) {
      return upgradeToGateway(request, server);
    }

    if (request.method === "OPTIONS") {
      if (matchOperatorRequest(pathname, "GET")) {
        return withAppOriginCors(
          new Response(null, { status: 204 }),
          request,
          allowedOrigins,
        );
      }
    }

    const match = matchOperatorRequest(pathname, request.method);
    if (match) {
      const response = await match.route.run({
        assistantId: match.assistantId,
        method: request.method,
        path: pathname + new URL(request.url).search,
        peer: server?.requestIP(request)?.address ?? null,
        headers: request.headers,
        body: request.body,
      });
      if (response) {
        return withAppOriginCors(response, request, allowedOrigins);
      }
    }

    const static_ = await serveStatic(request, spec);
    if (static_) return static_;

    return notFound();
  };
}

/**
 * The serve child's body: read the recorded serve spec, open the listener —
 * 127.0.0.1 only (every tunnel agent is pointed at that host explicitly) —
 * and write the pidfile only once the bind succeeded, so a recorded pid
 * always names the port's owner.
 */
function runAppServerChild(): void {
  const state = readAppServerState();
  const spec = state?.serve;
  if (!spec) {
    console.error("No app server serve spec on record; refusing to serve.");
    process.exit(1);
  }
  const handler = createAppServerHandler(spec);
  const websocket = gatewayRelayHandlers();
  const server = Bun.serve({
    port: state.listenPort,
    hostname: "127.0.0.1",
    fetch: handler,
    websocket,
  });
  console.log("Booting on", state.listenPort);
  const pidPath = getAppServerPaths().pidPath;
  mkdirSync(join(pidPath, ".."), { recursive: true });
  writeFileSync(pidPath, `${process.pid}\n`);
  process.on("SIGTERM", () => {
    console.warn("Received termination signal...");
    server.stop(true);
    process.exit(0);
  });
}

type RelayData = {
  upstream: WebSocket;
  /** Browser→gateway messages sent before the upstream opened. */
  queue: (string | Uint8Array<ArrayBuffer>)[];
};

/**
 * The gateway-facing side of a websocket upgrade: open the upstream with the
 * caller's own headers (plus the edge stamps), hand it to the browser socket
 * via the upgrade's data, and let the handler's open/message/close hooks
 * pipe both directions. Losing the upstream closes the browser side with the
 * tunnel-lost code the gateway's own bridge uses, so the client reads the
 * difference between "closed" and "lost".
 */
function upgradeToGateway(request: Request, server: AppServerHandle): Response {
  const url = new URL(request.url);
  // The relay targets the fronted assistant's gateway — the same live
  // lockfile resolution the web bundle's config rides. No entry, no
  // upstream to relay to.
  const entry = servedAssistantFromLockfile(readLockfile());
  if (!entry) {
    return new Response(null, { status: 502 });
  }
  const target = new URL(`${url.pathname}${url.search}`, getGatewayUrl(entry));
  target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (
      lower === "host" ||
      HOP_BY_HOP_HEADERS.has(lower) ||
      lower.startsWith("sec-websocket")
    ) {
      return;
    }
    headers[key] = value;
  });
  headers["X-Cadet-Client-Ip"] = edgeClientIp(
    request,
    server.requestIP(request)?.address ?? null,
  );
  let upstream: WebSocket;
  try {
    upstream = new WebSocket(target, {
      // @ts-expect-error ts(2353) - seems like a TS bug
      headers,
    });
  } catch {
    return new Response(null, { status: 502 });
  }
  const ok = server.upgrade(request, { data: { upstream, queue: [] } });
  if (!ok) {
    try {
      upstream.close();
    } catch {
      // Never opened.
    }
    return new Response(null, { status: 502 });
  }
  // The socket is hijacked; Bun ignores the response body.
  return new Response(null, { status: 101 });
}

/**
 * The browser-facing websocket handlers: the pipes are wired in `open`,
 * where the socket's data already carries the pending upstream.
 */
function gatewayRelayHandlers(): Bun.WebSocketHandler<RelayData> {
  return {
    open(ws) {
      const { upstream, queue } = ws.data;
      upstream.addEventListener("open", () => {
        for (const pending of queue.splice(0)) upstream.send(pending);
      });
      upstream.addEventListener("message", (event) => {
        ws.send(event.data);
      });
      const lose = () => {
        try {
          ws.close(
            GATEWAY_TUNNEL_LOST_WS_CLOSE_CODE,
            "gateway connection lost",
          );
        } catch {
          // Already closed.
        }
      };
      upstream.addEventListener("close", lose);
      upstream.addEventListener("error", lose);
    },
    message(ws, message) {
      const { upstream, queue } = ws.data;
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(message);
      } else if (upstream.readyState === WebSocket.CONNECTING) {
        queue.push(message);
      }
    },
    close(ws) {
      try {
        ws.data.upstream.close();
      } catch {
        // Already closed.
      }
    },
  };
}

if (import.meta.main) {
  runAppServerChild();
}
