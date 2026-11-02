import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { cloudAssistantHubUrl } from "@mycadet/environments";

import { GATEWAY_TUNNEL_LOST_WS_CLOSE_CODE } from "@mycadet/service-contracts/ingress";

import { resolveVersion } from "@mycadet/shared/version";

import {
  readRootProcesses,
  resolveTargetAssistant,
  stampRootProcess,
} from "../assistant-config.js";
import {
  getGatewayUrl,
  type InjectedConfig,
} from "@mycadet/local-mode/contract";
import {
  getAppServerPaths,
  getAppServerPid,
  appServerStatePath,
  getAssistantDisplayName,
  isAppServerRunning,
  lookupAssistantByIdentifier,
  readAppServerState,
  stopAppServer,
  type AppServerState,
} from "@mycadet/local-mode";
import { matchOperatorRequest } from "@mycadet/local-mode";
import { resolveLogDir } from "@mycadet/local-mode";
import { waitForDaemonReady } from "@mycadet/local-mode";
import { resolveClientDists } from "../web-dist.js";

/**
 * The CLI-managed app server: a Bun.serve process that supersedes the nginx
 * edge as the canonical tunnel target — browser → tunnel (TLS) → app
 * server@127.0.0.1 → gateway@127.0.0.1.
 *
 * One handler owns the whole surface, in priority order: the sensitive-route
 * denylist (never edge-reachable), the operator dispatch (the same route
 * table the Electron `app://` handler and the vite dev mount serve — the
 * real list and resolution rows replaced the frozen metadata JSON), the
 * static SPA surface (injected indexes, hashed assets, SPA fallbacks), and
 * the streaming gateway proxy for everything else. There is no loopback
 * gate: the server fronts remote browsers through the TLS front, and the
 * operator rows judge credentials from the forwarded headers themselves.
 *
 * `cadet tunnel` (and the wake restore path) bring it up via
 * `ensureAppServer` and always front its loopback listen port.
 */

export const DEFAULT_APP_SERVER_PORT = 7840;

/**
 * Sensitive local-only gateway paths the app server must never expose to the
 * internet, regardless of which client bundles are being served. Each exact
 * path is blocked with and without its trailing slash, in both the versioned
 * and — since the version prefix is optional at the gateway — the unversioned
 * spelling, from the origin root and from the `/web` iframe prefix (the web
 * UI's prefix-aware API paths put the same routes at `/web/v1/...`).
 */
const SENSITIVE_GATEWAY_ROUTES = [
  "/auth/token",
  "/v1/pair",
  "/v1/pair/web-init",
  "/v1/devices",
  "/v1/devices/revoke",
  "/v1/remote-web/pairing-requests",
  "/v1/remote-web/pairing-requests/approve",
  "/v1/remote-web/pairing-requests/deny",
  "/v1/remote-web/pairing-verification",
  "/v1/shared/invites/redeem",
] as const;

const DENY_PATHS: ReadonlySet<string> = (() => {
  const paths = new Set<string>();
  for (const route of SENSITIVE_GATEWAY_ROUTES) {
    // The version prefix is optional at the gateway (P7 of the one-url plan):
    // block the unversioned spelling of every /v1 route too, so the sensitive
    // paths never gain a reachable alias through the new unversioned surface.
    const unversioned = route.replace(/^\/v1(?=\/)/, "");
    for (const spelling of unversioned === route
      ? [route]
      : [route, unversioned]) {
      paths.add(spelling);
      paths.add(`${spelling}/`);
      paths.add(`/web${spelling}`);
      paths.add(`/web${spelling}/`);
    }
  }
  return paths;
})();

/** Stable fingerprint of the injected SPA config and its source bundles,
 * recorded alongside the app server's state so a reuse decision can tell
 * whether a running server already serves the requested config. Any change
 * that matters reaches the running server through the config, dist, or
 * version inputs hashed here. */
function remoteWebConfigFingerprint(
  config: Record<string, unknown>,
  webDistDir: string,
  version: string | undefined,
  appDistDir: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        config,
        webDistDir,
        version,
        appDistDir,
        appIndexHtml: readFileSync(join(appDistDir, "index.html"), "utf-8"),
        indexHtml: readFileSync(join(webDistDir, "index.html"), "utf-8"),
      }),
    )
    .digest("hex");
}

function safeScriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
}

/**
 * How many modulepreload hints the served index may carry before they are
 * stripped wholesale.
 *
 * The consolidated boot graph emits 4 hints (the entry chunk's static
 * imports). Serving them lets a phone fetch the whole boot set in parallel;
 * without them the browser cannot discover the other chunks until the entry
 * has downloaded AND parsed, so ~515 kB gzip serializes behind ~623 kB plus
 * a phone-CPU parse of ~2.2 MB of JavaScript.
 *
 * The strip exists for the pathological shape: a whole-chunk-graph index
 * (~290 hints) floods the tunnel with requests, and one dropped *import*
 * blanks the app before React can report it. A build that regresses toward
 * that shape trips this threshold and gets the protective strip.
 * All-or-nothing, because preserving an arbitrary prefix of a broken graph
 * would be luck, not policy. 12 sits comfortably above the consolidated
 * graph and within two rounds of the browser's six-per-origin HTTP/1.1
 * connection pool, so kept hints never widen concurrency much beyond what
 * the entry's own imports would open.
 */
export const MAX_PRESERVED_MODULE_PRELOADS = 12;

const MODULE_PRELOAD_RE = /<link[^>]+rel="modulepreload"[^>]*>\s*/g;

/**
 * Failure semantics are engine-dependent while whatwg/html#10327 rolls out:
 * older engines cache a failed module fetch in the module map (a later
 * import returns the failure without refetching), newer ones evict it so a
 * later import refetches. The invariant that matters holds in both models:
 * the preserved hints name exactly the URLs the entry's static imports
 * fetch anyway, through the same module map, so a dropped request for a
 * BOOT chunk has the same outcome whether or not the chunk was hinted.
 * Hints for the boot set add no failure surface; they only start the same
 * fetches earlier. What the strip guards against is the whole-graph shape,
 * where hundreds of speculative NON-boot fetches amplify the odds of any
 * failure and (on old-model engines) a dropped lazy chunk poisons a later
 * dynamic import.
 */
function stripExcessModulePreloads(html: string): string {
  const count = html.match(MODULE_PRELOAD_RE)?.length ?? 0;
  if (count <= MAX_PRESERVED_MODULE_PRELOADS) {
    return html;
  }
  return html.replace(MODULE_PRELOAD_RE, "");
}

export function buildRemoteWebIndexHtml(
  rawHtml: string,
  config: Record<string, unknown>,
): string {
  const html = stripExcessModulePreloads(rawHtml);
  const script = `<script>window.__CADET_CONFIG__=${safeScriptJson(config)}</script>`;
  if (html.includes("</head>")) {
    return html.replace("</head>", `${script}</head>`);
  }
  return `${script}${html}`;
}

/** Whether the host has an IPv6 loopback to bind. False on Linux installs with
 * IPv6 disabled; the server binds both stacks when it has one (a tunnel agent
 * pointed at "localhost" reaches ::1 first on macOS). */
export function hasIpv6Loopback(): boolean {
  return Object.values(networkInterfaces())
    .flatMap((addrs) => addrs ?? [])
    .some((addr) => addr.address === "::1");
}

/** Whether a TCP listener already holds `port` on the given loopback host. */
async function isPortInUse(
  port: number,
  host: "127.0.0.1" | "::1",
): Promise<boolean> {
  return await new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(true));
    probe.once("listening", () => {
      probe.close(() => resolve(false));
    });
    probe.listen(port, host);
  });
}

/**
 * The first free loopback port at or above `startPort`, scanning a short band,
 * or null when the whole band is busy. Both stacks the server may bind are
 * probed (the IPv4 loopback always, the IPv6 loopback when the host has one),
 * so the returned port is one the server can actually take.
 */
export async function findAvailableServerPort(
  startPort: number,
  attempts = 20,
): Promise<number | null> {
  const checkIpv6 = hasIpv6Loopback();
  for (let port = startPort; port < startPort + attempts; port++) {
    if (await isPortInUse(port, "127.0.0.1")) {
      continue;
    }
    if (checkIpv6 && (await isPortInUse(port, "::1"))) {
      continue;
    }
    return port;
  }
  return null;
}

const AssistantHostConfigSchema = z.object({
  assistantId: z.string().min(1).optional(),
  assistantName: z.string().optional(),
  version: z.string().min(1).optional(),
  hubUrl: z.string().url().optional(),
});

function assistantHostConfig(config: Record<string, unknown>) {
  const result = AssistantHostConfigSchema.safeParse(config);
  if (!result.success) {
    throw new Error("Invalid assistant host configuration.");
  }
  return result.data;
}

/**
 * The Capacitor mobile shells' own webview origins: the iOS WKWebView serves
 * the bundled app from `capacitor://localhost`, and the Android WebView from
 * `https://localhost` (Capacitor's default `androidScheme`; `http://localhost`
 * was the pre-Capacitor-5 default). No web page can dispatch a fetch bearing
 * a custom-scheme Origin — a browser only emits it from the shell itself —
 * so allowlisting them at the app server is the mobile-shell equivalent of a
 * same-origin read.
 */
const CAPACITOR_APP_ORIGINS = [
  "capacitor://localhost",
  "https://localhost",
  "http://localhost",
];

function appOrigins(config: Record<string, unknown>): string[] {
  const metadata = assistantHostConfig(config);
  const origins = [
    ...CAPACITOR_APP_ORIGINS,
    ...(metadata.hubUrl ? [new URL(metadata.hubUrl).origin] : []),
  ];
  return [...new Set(origins)].map((origin) => {
    // The Capacitor shells' origins are fixed platform values, not parsed:
    // `new URL("capacitor://localhost").origin` serializes as "null" (a
    // non-special scheme), so they are matched literally above the URL
    // validation the configurable origins go through.
    if (CAPACITOR_APP_ORIGINS.includes(origin)) {
      return origin;
    }
    const url = new URL(origin);
    if (
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
        )) ||
      url.origin !== origin.replace(/\/$/, "")
    ) {
      throw new Error(
        "App origins must be HTTPS origins or loopback HTTP origins.",
      );
    }
    return url.origin;
  });
}

/** The tunnel URL on record (the root lockfile's `tunnel.publicUrl`, stamped
 * by whichever run established the tunnel), or undefined when none is — the
 * served config stamps it as `cloudUrl` so tunnel clients' account/auth
 * surfaces stay on the origin they came in on. */
function savedPublicBaseUrl(): string | undefined {
  try {
    const url = readRootProcesses().tunnel?.publicUrl;
    if (!url || !url.trim()) return undefined;
    return url.trim();
  } catch {
    return undefined;
  }
}

/**
 * What the spawned server child serves: the upstream, the dist roots, and
 * the injected documents. The starting parent writes it into `state.json`;
 * the child is stateless beyond it.
 */
export interface AppServerSpec {
  gatewayUrl: string;
  webDistDir: string;
  appDistDir: string;
  indexHtmlPath: string;
  appIndexHtmlPath: string;
  config: Record<string, unknown>;
}

/**
 * The content types the static tier compresses. Compression stays a STATIC
 -only affordance: this server also proxies authenticated /v1 and /webhooks
 * traffic, and compressing a response that carries both a secret and
 * attacker-influenced content over TLS is the BREACH side channel. The SPA
 * bytes are the whole win, so the boundary is drawn by opting the static
 * responses in rather than by excluding proxies.
 */
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
    return new Response(body.text, { headers });
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
    const text = await file.text();
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
 * Proxy a request to the gateway upstream, streaming both ways: the body
 * rides as the raw stream (a passing operator row leaves it untouched), the
 * response streams back with the hop-by-hop and length headers stripped
 * (fetch decodes the upstream's content-encoding, so the lengths no longer
 * describe the bytes).
 */
async function proxyToGateway(
  request: Request,
  spec: AppServerSpec,
  peer: string | null,
  rewritePath?: (pathname: string) => string,
): Promise<Response> {
  const url = new URL(request.url);
  const path = rewritePath ? rewritePath(url.pathname) : url.pathname;
  const target = new URL(`${path}${url.search}`, spec.gatewayUrl);
  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (key.toLowerCase() === "host") return;
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) return;
    headers.set(key, value);
  });
  headers.set("X-Cadet-Edge-Forwarded", "1");
  headers.set("X-Cadet-Client-Ip", edgeClientIp(request, peer));
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const upstream = await fetch(target, {
    method: request.method,
    headers,
    ...(hasBody ? { body: request.body, duplex: "half" as const } : {}),
    redirect: "manual",
  });
  const outHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) return;
    if (["content-length", "content-encoding"].includes(key.toLowerCase())) {
      return;
    }
    outHeaders.set(key, value);
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: outHeaders,
  });
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
  const configJson = JSON.stringify(spec.config);

  // The web SPA's iframe mount: exact rewrites to the injected document,
  // the inline config, then the dist's own files with the document as the
  // SPA fallback.
  if (pathname === "/web") return redirect("/web/assistant/");
  if (
    pathname === "/web/assistant" ||
    pathname === "/web/assistant/" ||
    pathname === "/web/assistant/index.html"
  ) {
    if (pathname === "/web/assistant") return redirect("/web/assistant/");
    return staticResponse(request, { file: spec.indexHtmlPath }, "no-cache");
  }
  if (pathname === "/web/assistant/__config") {
    return staticResponse(
      request,
      { text: configJson, type: "application/json" },
      "no-store",
    );
  }
  if (pathname === "/web/assistant/__remote-index.html") {
    return notFound(); // internal in the nginx map; not directly fetchable
  }
  if (pathname.startsWith("/web/assistant/")) {
    const file = join(
      spec.webDistDir,
      pathname.slice("/web/assistant/".length),
    );
    if (await Bun.file(file).exists()) {
      return staticResponse(request, { file }, "no-cache");
    }
    return staticResponse(request, { file: spec.indexHtmlPath }, "no-cache");
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
  if (pathname === "/__cadet-app-index.html") {
    return notFound(); // internal in the nginx map; not directly fetchable
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
  options: {
    requestIP?: (request: Request, server?: AppServerHandle) => string | null;
  } = {},
): (request: Request, server?: AppServerHandle) => Promise<Response> {
  const allowedOrigins = appOrigins(spec.config);
  const peerOf = options.requestIP;
  return async function fetch(request, server) {
    const pathname = new URL(request.url).pathname;

    if (DENY_PATHS.has(pathname)) {
      return notFound();
    }

    // Websocket upgrades are handled here, before any HTTP tier: the
    // gateway's channels are never operator rows or static paths.
    if ((request.headers.get("upgrade") ?? "") !== "" && server) {
      return upgradeToGateway(request, server, spec);
    }

    // A preflight is blessed where a read is served (the old nginx map
    // answered OPTIONS only inside the read locations): the allowlisted
    // shells' cross-origin reads get the browser's blessing, everything
    // else stays same-origin-governed.
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
        headers: request.headers,
        body: request.body,
      });
      if (response) {
        return withAppOriginCors(response, request, allowedOrigins);
      }
    }

    const static_ = await serveStatic(request, spec);
    if (static_) return static_;

    const peer = peerOf?.(request, server) ?? null;
    return proxyToGateway(request, spec, peer, (p) =>
      // The /web twin hands the iframe namespace's remainder to the same /v1
      // translation the ^~ /web/v1/ location did; the gateway's router
      // resolves the /v1 prefix on the unversioned spellings.
      p.startsWith("/web/v1/")
        ? p.slice("/web".length)
        : p.startsWith("/web/")
          ? `/v1/${p.slice("/web/".length)}`
          : p,
    );
  };
}

function saveAppServerState(state: AppServerState): void {
  mkdirSync(getAppServerPaths().dir, { recursive: true });
  writeFileSync(appServerStatePath(), JSON.stringify(state, null, 2) + "\n");
}

export const APP_SERVER_READY_TIMEOUT_MS = 5_000;

/**
 * Outcome of an attempt to bring up the app server. Callers render their own
 * messaging per variant: `ensureAppServer` maps failure variants to thrown
 * errors with actionable text, which `cadet tunnel` and `cadet app up` print
 * before exiting non-zero while the wake restore path warns and continues.
 */
export interface AppServerStartedResult {
  status: "started";
  listenPort: number;
  /** SPA dist directory served by the app server. */
  webDistDir: string;
  version: string;
  /**
   * The checkout HEAD the dists were built at (the empty string when the
   * checkout has no git anchor), so the server's lockfile record carries the
   * build stamp from birth — `stampAppProcessEntry` replaces the record
   * wholesale, and a stamp that only lands via `stampAppBuiltSha` before
   * the record exists is dropped.
   */
  builtSha: string;
}

export interface AppServerAlreadyRunningResult {
  status: "already-running";
  /** Recorded listen port of the running server (requested port when no state is recorded). */
  listenPort: number;
  /** Recorded gateway upstream; undefined when the record predates the field. */
  gatewayUrl?: string;
  /**
   * Set when the surviving server matches the requested gateway upstream but
   * serves a different injected SPA config than requested (a restart was
   * attempted and failed), so the served index is stale.
   */
  staleRemoteWebConfig?: true;
  /**
   * The surviving server's own build stamp, when its lockfile record has one —
   * carried so `stampAppProcessEntry` re-stamps the record without losing it.
   */
  builtSha?: string;
}

export interface AppServerWebDistMissingResult {
  status: "web-dist-missing";
}

export interface AppServerAppDistMissingResult {
  status: "app-dist-missing";
}

export interface AppServerUnreachableResult {
  status: "unreachable";
  listenPort: number;
  logPath: string;
}

export interface AppServerPortConflictResult {
  status: "port-conflict";
  listenPort: number;
  logPath: string;
}

export type StartAppServerResult =
  | AppServerStartedResult
  | AppServerAlreadyRunningResult
  | AppServerWebDistMissingResult
  | AppServerAppDistMissingResult
  | AppServerUnreachableResult
  | AppServerPortConflictResult;

/**
 * Write the serve spec and start the app server child, probe /healthz
 * through it to prove the server → gateway path is live, and confirm via
 * the recorded pid file that the spawned child owns the listen port (the
 * child writes the pidfile only after a successful bind, so ownership is
 * inherent). A spawned but unreachable child is rolled back so a failed
 * attempt leaves no half-up server behind.
 *
 * A server already running against the requested gateway upstream and
 * serving the requested injected SPA config short-circuits as
 * `already-running`; one against a different gateway upstream, or serving a
 * drifted SPA config (e.g. a renamed assistant or an updated hub URL), is
 * stopped and restarted with the requested config. The server is
 * assistant-agnostic: it carries no assistant identity in its options —
 * `getGatewayUrl` of the entry it fronts is the routing decision, resolved
 * from the lockfile by the caller.
 *
 * Pure mechanism: it performs no console output and never exits the process, so
 * every caller (`cadet tunnel`, `cadet app up`, the wake restore path)
 * can share one implementation and map the returned result to its own UX.
 */
export async function startAppServer(opts: {
  /** Where the app server proxies gateway traffic — `getGatewayUrl` of the fronted entry. */
  gatewayUrl: string;
  /**
   * Serving assistant's id, stamped into the served remote-web config
   * (`__CADET_CONFIG__.assistantId`) so a caller probing this origin can
   * confirm which assistant the app server fronts.
   */
  assistantId: string;
}): Promise<StartAppServerResult> {
  let listenPort = DEFAULT_APP_SERVER_PORT;

  const running = isAppServerRunning();
  const recorded = running ? readAppServerState() : null;
  if (recorded) {
    listenPort = recorded.listenPort;
  }
  const { webDistDir, appDistDir, builtSha } = await resolveClientDists();
  if (!webDistDir) {
    return { status: "web-dist-missing" };
  }
  if (!appDistDir) {
    return { status: "app-dist-missing" };
  }
  // The app server serves the CLI's own bundles, so the version it stamps
  // answers "which cadet is running this" — the CLI's own stamp, not the
  // gateway runtime's. stampedVersion is stable for a given checkout (the
  // stamp's timestamp is the HEAD commit's), so the fingerprint below never
  // drifts between processes.
  const version = resolveVersion(join(import.meta.dir, "../../.."));
  // The caller resolved this assistant from the lockfile moments ago, so
  // the entry is there: a miss means the lockfile changed under us, which
  // is a bug to stop on, not a config to guess through.
  const assistant = lookupAssistantByIdentifier(opts.assistantId);
  if (assistant.status !== "found") {
    throw new Error(
      `The assistant ${opts.assistantId} is not in the lockfile, but the app server was asked to serve its UI.`,
    );
  }
  const config: InjectedConfig = {
    remote: assistant.entry.cloud,
    assistantName: getAssistantDisplayName(assistant.entry),
    assistantId: opts.assistantId,
    hubUrl: cloudAssistantHubUrl(),
    cloudUrl: savedPublicBaseUrl(),
    version,
  };
  const fingerprint = remoteWebConfigFingerprint(
    config,
    webDistDir,
    version,
    appDistDir,
  );
  // A record without a fingerprint predates the field and counts as drifted
  // (see AppServerState).
  const configMatches = recorded?.remoteWebConfigHash === fingerprint;
  // The surviving server's lockfile record holds its own build stamp; carrying
  // it on the result means `stampAppProcessEntry` re-stamps without losing it
  // (it replaces the record wholesale).
  const survivingBuiltSha = readRootProcesses().app?.builtSha;
  const alreadyRunning = (): AppServerAlreadyRunningResult => ({
    status: "already-running",
    listenPort: recorded?.listenPort ?? listenPort,
    ...(recorded?.gatewayUrl !== undefined
      ? { gatewayUrl: recorded.gatewayUrl }
      : {}),
    ...(recorded?.gatewayUrl === opts.gatewayUrl && !configMatches
      ? { staleRemoteWebConfig: true as const }
      : {}),
    ...(survivingBuiltSha ? { builtSha: survivingBuiltSha } : {}),
  });
  // An unknown recorded gateway upstream is unverified (see AppServerState).
  if (running && recorded?.gatewayUrl === opts.gatewayUrl && configMatches) {
    return alreadyRunning();
  }

  // The running server targets a different gateway upstream or injects a
  // stale SPA config; restart it with the requested config. A false stop can
  // mean the old server exited on its own after the check above, so recheck
  // liveness and only bail when it is still serving.
  if (running && !(await stopAppServer()) && isAppServerRunning()) {
    return alreadyRunning();
  }

  // A foreign process squatting the default port (another assistant's app
  // server, a stale dev server) must not kill the tunnel: the port is
  // loopback-local and the public tunnel URL never carries it, so moving to
  // the next free port is invisible to remote clients.
  const discovered = await findAvailableServerPort(listenPort);
  if (discovered !== null && discovered !== listenPort) {
    console.log(`Port ${listenPort} in use; using ${discovered} instead.`);
    listenPort = discovered;
  }

  // The app server's private state lives under the XDG data dir (never an
  // assistant workspace): the pidfile, the serve spec, and the two index
  // documents — each injected with the served config, so the server never
  // serves the build-time vite stamp the dist indexes carry.
  const paths = getAppServerPaths();
  mkdirSync(paths.dir, { recursive: true });
  mkdirSync(resolveLogDir(), { recursive: true });
  const indexHtmlPath = join(paths.dir, "assistant-index.html");
  const appIndexHtmlPath = join(paths.dir, "app-index.html");
  const rawIndexHtml = readFileSync(join(webDistDir, "index.html"), "utf-8");
  writeFileSync(indexHtmlPath, buildRemoteWebIndexHtml(rawIndexHtml, config));
  // The app shell gets its own injected document: the same injected config,
  // written beside the web one.
  const rawAppIndexHtml = readFileSync(join(appDistDir, "index.html"), "utf-8");
  writeFileSync(
    appIndexHtmlPath,
    buildRemoteWebIndexHtml(rawAppIndexHtml, config),
  );
  saveAppServerState({
    listenPort,
    gatewayUrl: opts.gatewayUrl,
    remoteWebConfigHash: fingerprint,
    serve: {
      gatewayUrl: opts.gatewayUrl,
      webDistDir,
      appDistDir,
      indexHtmlPath,
      appIndexHtmlPath,
      config,
    },
  });
  const fd = openSync(paths.logPath, "a");
  // The server runs as a detached child of THIS module (bun executes the
  // file directly; `import.meta.main` below opens the listener and writes
  // the pidfile once the bind succeeds). The state dir rides as the second
  // argument so a stale pidfile can never pass the ps-cmdline ownership
  // check against another workspace's server — the same reason nginx got
  // `-p <prefix dir>`.
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), paths.dir],
    {
      detached: true,
      stdio: ["ignore", fd, fd],
      windowsHide: true,
    },
  );
  closeSync(fd);
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  child.unref();

  // /healthz proxies to the gateway, so a 200 proves the whole server →
  // gateway path works.
  const ready = await waitForDaemonReady(
    listenPort,
    APP_SERVER_READY_TIMEOUT_MS,
  );
  const rollback = async (
    status: "port-conflict" | "unreachable",
  ): Promise<AppServerUnreachableResult | AppServerPortConflictResult> => {
    const { logPath } = getAppServerPaths();
    await stopAppServer();
    return { status, listenPort, logPath };
  };
  const childExited = (): boolean => exited || child.exitCode !== null;
  if (!ready) {
    return rollback(childExited() ? "port-conflict" : "unreachable");
  }
  // A successful probe alone does not prove ownership either: a healthy
  // server from another workspace answers /healthz before our child
  // finishes failing its bind. A child that won the bind wrote its pid
  // under our prefix, so settle-poll until the spawn either exits (lost the
  // bind) or that pid file names a live server of ours (owns the port).
  const deadline = Date.now() + 4_000;
  for (;;) {
    if (childExited()) {
      break;
    }
    if (getAppServerPid() !== null) {
      return {
        status: "started",
        listenPort,
        webDistDir,
        version,
        builtSha,
      };
    }
    if (Date.now() >= deadline) {
      try {
        child.kill("SIGTERM");
      } catch {
        // Already gone; the rollback below clears any remaining state.
      }
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return rollback("port-conflict");
}

/**
 * The serve child's body: read the recorded serve spec, open the listener(s)
 * — both loopback stacks when the host has IPv6 (a tunnel agent pointed at
 * "localhost" reaches ::1 first on macOS) — and write the pidfile only once
 * the bind succeeded, so a recorded pid always names the port's owner.
 */
function runAppServerChild(): void {
  const state = readAppServerState();
  const spec = state?.serve;
  if (!spec) {
    console.error("No app server serve spec on record; refusing to serve.");
    process.exit(1);
  }
  const handler = createAppServerHandler(spec, {
    requestIP: (request, server) => server?.requestIP(request)?.address ?? null,
  });
  const websocket = gatewayRelayHandlers();
  const servers = [
    Bun.serve({
      port: state.listenPort,
      hostname: "127.0.0.1",
      fetch: handler,
      websocket,
    }),
  ];
  if (hasIpv6Loopback()) {
    servers.push(
      Bun.serve({
        port: state.listenPort,
        hostname: "::1",
        fetch: handler,
        websocket,
      }),
    );
  }
  writeFileSync(getAppServerPaths().pidPath, `${process.pid}\n`);
  process.on("SIGTERM", () => {
    for (const server of servers) server.stop(true);
    process.exit(0);
  });
}

type RelayData = {
  upstream: WebSocket;
  /** Browser→gateway messages sent before the upstream opened. */
  queue: (string | Uint8Array)[];
};

type HeaderCapableWebSocket = {
  new (url: URL, options?: { headers?: Record<string, string> }): WebSocket;
};
const HeaderWebSocket = WebSocket as unknown as HeaderCapableWebSocket;

/**
 * The gateway-facing side of a websocket upgrade: open the upstream with the
 * caller's own headers (plus the edge stamps), hand it to the browser socket
 * via the upgrade's data, and let the handler's open/message/close hooks
 * pipe both directions. Losing the upstream closes the browser side with the
 * tunnel-lost code the gateway's own bridge uses, so the client reads the
 * difference between "closed" and "lost".
 */
function upgradeToGateway(
  request: Request,
  server: AppServerHandle,
  spec: AppServerSpec,
): Response {
  const url = new URL(request.url);
  const target = new URL(`${url.pathname}${url.search}`, spec.gatewayUrl);
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
  headers["X-Cadet-Edge-Forwarded"] = "1";
  headers["X-Cadet-Client-Ip"] = edgeClientIp(
    request,
    server.requestIP(request)?.address ?? null,
  );
  let upstream: WebSocket;
  try {
    upstream = new HeaderWebSocket(target, { headers });
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
        ws.send(event.data as string | Uint8Array);
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

/** Record the running server's pid in the root lockfile for `cadet ps`. */
function stampAppProcessEntry(
  result: AppServerStartedResult | AppServerAlreadyRunningResult,
): void {
  const pid = getAppServerPid();
  if (pid === null) return;
  // `stampRootProcess` replaces the record wholesale, so the build stamp
  // rides the result — a fresh start carries the resolve's sha, an
  // already-running server its own record's. Without it a fresh record reads
  // "no build stamp" and the next dist resolve rebuilds.
  stampRootProcess("app", {
    pid,
    startedAt: new Date().toISOString(),
    port: result.listenPort,
    builtSha: result.builtSha,
  });
}

/** Resolved server a tunnel (or bring-your-own HTTPS front) should target. */
export interface AppServer {
  /** Loopback listen port the HTTPS front should forward to. */
  port: number;
  /** True when this call started the server, false when a running one was reused. */
  started: boolean;
}

/**
 * Recovery text for a drifted server that outlived the automatic restart.
 * `startAppServer` already escalated SIGTERM to SIGKILL before
 * reporting `already-running`, so the only thing left is the wedged process
 * itself: name its PID and log so the user can clear it by hand.
 */
function stuckAppServerRecoveryHint(): string {
  const { logPath } = getAppServerPaths();
  const pid = getAppServerPid();
  const target = pid !== null ? `the app server process (PID ${pid})` : "it";
  return (
    `Cadet could not stop ${target}, even with SIGKILL. ` +
    `Stop it by hand and retry, or run \`cadet sleep\` to shut the ` +
    `assistant down entirely. Check the log: ${logPath}`
  );
}

/**
 * Bring up the app server as the canonical tunnel target and return the
 * listen port a tunnel should front.
 *
 * The server is assistant-agnostic: it carries no assistant identity in its
 * options. The assistant it fronts — and with it the gateway it proxies, via
 * `getGatewayUrl` — is resolved from the lockfile here (the active assistant,
 * else the only entry), so every caller shares one resolution instead of
 * threading bespoke ids and ports. Its own state (pidfile, recorded
 * upstream, serve spec) lives under the XDG data dir, never an assistant
 * workspace.
 *
 * The server always serves the SPA alongside the gateway proxy. It is always
 * delegated to `startAppServer`, which reuses a running server whose
 * gateway upstream and injected SPA config match and restarts one that
 * drifted in any respect, so the returned port always fronts the requested
 * config. `started` is false when a matching server was reused; a drifted
 * server that survives the restart attempt throws rather than reporting the
 * wrong config. Failures throw with actionable diagnostic text.
 */
export async function ensureAppServer(): Promise<AppServer> {
  const entry = resolveTargetAssistant();
  const gatewayUrl = getGatewayUrl(entry);
  const result = await startAppServer({
    gatewayUrl,
    assistantId: entry.assistantId,
  });

  switch (result.status) {
    case "started":
      stampAppProcessEntry(result);
      return {
        port: result.listenPort,
        started: true,
      };
    case "already-running": {
      // `already-running` also covers a drifted server whose restart failed,
      // so trust the recorded state it carries over the requested config.
      if (result.gatewayUrl !== gatewayUrl) {
        throw new Error(
          `The app server is still proxying ${result.gatewayUrl ?? "an unknown gateway upstream"} ` +
            `and could not be restarted against ${gatewayUrl}. ` +
            stuckAppServerRecoveryHint(),
        );
      }
      if (result.staleRemoteWebConfig) {
        throw new Error(
          "The app server is still serving an outdated remote web config " +
            "and could not be restarted with the updated one. " +
            stuckAppServerRecoveryHint(),
        );
      }
      stampAppProcessEntry(result);
      return {
        port: result.listenPort,
        started: false,
      };
    }
    case "web-dist-missing":
      throw new Error(
        "Unable to locate built web assets for the remote web app server. " +
          "Build the SPA with `cd clients/web && VITE_CLOUD_MODE=false bun run build`, " +
          "or install @mycadet/web so its packaged dist directory is available.",
      );
    case "app-dist-missing":
      throw new Error(
        "No built app shell bundle is available. Build it with " +
          "`cd clients/app && bun run build`, " +
          "or install @mycadet/app so its packaged standalone directory is available.",
      );
    case "unreachable":
      throw new Error(
        `The app server did not become reachable on 127.0.0.1:${result.listenPort}. ` +
          `Check the log: ${result.logPath}`,
      );
    case "port-conflict":
      throw new Error(
        `The app server exited on startup, most likely because 127.0.0.1:${result.listenPort} ` +
          "is already in use (for example by another assistant's app server). " +
          "Stop whatever is bound to that port, then retry. " +
          `Check the log: ${result.logPath}`,
      );
  }
}

if (import.meta.main) {
  runAppServerChild();
}
