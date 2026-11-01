import { spawn, spawnSync } from "node:child_process";
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

import { z } from "zod";

import { cloudAssistantHubUrl } from "@mycadet/environments";

import { resolveVersion } from "@mycadet/shared/version";

import {
  readRootProcesses,
  resolveTargetAssistant,
  stampRootProcess,
} from "../assistant-config.js";
import {
  getGatewayUrl,
  type InjectedConfig,
  type Remote,
} from "@mycadet/local-mode/contract";
import {
  getAssistantDisplayName,
  getIngressPaths,
  getIngressPid,
  ingressStatePath,
  isIngressRunning,
  lookupAssistantByIdentifier,
  readIngressState,
  stopIngressNginx,
  type IngressState,
} from "@mycadet/local-mode";
import { resolveLogDir } from "@mycadet/local-mode";
import { waitForDaemonReady } from "../http-client.js";
import { resolveEdgeClientDists } from "../web-dist.js";

// The edge's read/stop surface lives in `@mycadet/local-mode` (the retire
// operation stops the edge in-process); re-exported here for the tunnel and
// ps surfaces.
export {
  getIngressPaths,
  isIngressRunning,
  isPidAlive,
  readIngressState,
  getIngressPid,
  stopIngressNginx,
  stopContainerAppServer,
} from "@mycadet/local-mode";
export type { IngressPaths, IngressState } from "@mycadet/local-mode";

/**
 * CLI-managed nginx reverse proxy that fronts the gateway as the canonical
 * tunnel target: browser → tunnel (TLS) → nginx@127.0.0.1 → gateway@127.0.0.1.
 *
 * `cadet tunnel` (and the wake restore path) bring this edge up via
 * `ensureAppServer` and always front its loopback listen port.
 */

export const DEFAULT_NGINX_INGRESS_PORT = 7840;

function nginxQuoted(value: string, label: string): string {
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} contains a control character`);
  }
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")}"`;
}

function nginxDirPath(dir: string): string {
  return dir.endsWith("/") ? dir : `${dir}/`;
}

function gatewayProxyBlock(gatewayUrl: string, upstreamPath = ""): string {
  return `      proxy_pass ${gatewayUrl}${upstreamPath};
      proxy_http_version 1.1;
      proxy_request_buffering off;
      proxy_buffering off;
      proxy_read_timeout 1h;
      proxy_set_header Host $host;
      proxy_set_header X-Cadet-Edge-Forwarded "1";
      proxy_set_header X-Cadet-Client-Ip $cadet_edge_client_ip;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection $connection_upgrade;`;
}

/**
 * Sensitive local-only gateway paths the edge must never expose to the
 * internet, regardless of which client bundles are being served. Each exact
 * path is blocked with and without its trailing slash, in both the versioned
 * and — since the version prefix is optional at the gateway — the unversioned
 * spelling.
 */
const SENSITIVE_GATEWAY_ROUTES = [
  "/auth/token",
  "/v1/pair",
  "/v1/pair/web-init",
  "/v1/devices",
  "/v1/devices/revoke",
  "/v1/guardian/init",
  "/v1/guardian/reset-bootstrap",
  "/v1/remote-web/pairing-requests",
  "/v1/remote-web/pairing-requests/approve",
  "/v1/remote-web/pairing-requests/deny",
  "/v1/remote-web/pairing-verification",
  "/v1/shared/invites/redeem",
] as const;

/**
 * Denylist locations for gateway paths under one public prefix. The edge
 * serves from the origin root (web mode) and — in app mode — from the
 * `/web` iframe prefix, where the web UI's prefix-aware API paths
 * (`remoteGatewayApiPath`) put the same gateway routes at `/web/v1/...`;
 * the sensitive ones must be blocked in both spellings.
 */
function denylistLocations(prefix = ""): string {
  const exact = SENSITIVE_GATEWAY_ROUTES.map((route) => {
    const block = (path: string) =>
      `    location = ${prefix}${path} { return 404; }`;
    // The version prefix is optional at the gateway (P7 of the one-url plan):
    // block the unversioned spelling of every /v1 route too, so the sensitive
    // paths never gain a reachable alias through the new unversioned surface.
    const unversioned = route.replace(/^\/v1(?=\/)/, "");
    const spellings = unversioned === route ? [route] : [route, unversioned];
    return spellings
      .map((spelling) => `${block(spelling)}\n${block(`${spelling}/`)}`)
      .join("\n");
  });
  return exact.join("\n");
}

const DENYLIST_LOCATIONS = denylistLocations();

/**
 * The web UI entry the assistant detail API hands the shell, relative to the
 * origin root: the distinct /web/assistant/ iframe namespace, so the shell's
 * own /assistant/* host routes can never load the shell recursively.
 */
export const ASSISTANT_ENTRY_URL = "web/assistant/";

// The edge serves remote browsers, so the bundle's remote-gateway machinery
// must always run: it is reached through this self-hosted edge however the
// cadet itself is hosted. "cloud" is never stamped (the cloud serves its
// own bundles).
/** The lockfile's recorded remote kind for the assistant, if one is found. */
function lockfileAssistantRemote(assistantId: string): Remote | undefined {
  const result = lookupAssistantByIdentifier(assistantId);
  return result.status === "found" ? result.entry.cloud : undefined;
}

/**
 * Stable fingerprint of the injected SPA config and its source bundles,
 * recorded alongside the edge state so a reuse decision can tell whether a
 * running edge already serves the requested config (see
 * `IngressState.remoteWebConfigHash`). The rendered nginx template carries no
 * independent identity: any template change that matters reaches the running
 * edge through the config, dist, or version inputs hashed here.
 */
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

/**
 * Whether the host has an IPv6 loopback to bind. False on Linux installs with
 * IPv6 disabled, where emitting the listener would make nginx exit at startup
 * rather than fall back to IPv4.
 */
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
 * or null when the whole band is busy. Both stacks the edge may bind are
 * probed (the IPv4 loopback always, the IPv6 loopback when the host has one),
 * so the returned port is one nginx can actually take.
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
 * so allowlisting them at every edge is the mobile-shell equivalent of the
 * loopback allowlist.
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

function assistantMetadataLocations(config: Record<string, unknown>): string {
  const metadata = assistantHostConfig(config);
  const id = metadata.assistantId;
  const entryUrl =
    typeof config.entryUrl === "string" ? config.entryUrl : undefined;
  const choice = id
    ? {
        id,
        ...(metadata.assistantName ? { name: metadata.assistantName } : {}),
        // Each assistant carries its own hosting kind (the review follow-up
        // on #543): the chooser labels rows individually, so the edge stamps
        // the served assistant's lockfile cloud — the truthful remote kind,
        // NOT the served-SPA spelling (that one deliberately reads "custom"
        // so remote browsers run the remote-gateway machinery; an assistant
        // fact has no such excuse). Undefined drops out of the JSON body.
        remote: lockfileAssistantRemote(id),
      }
    : undefined;
  const responses = [
    {
      path: "/v1/assistants",
      status: 200,
      body: { results: choice ? [choice] : [], next: null },
    },
    ...(choice && id
      ? [
          {
            path: `/v1/assistants/${encodeURIComponent(id)}`,
            status: metadata.version ? 200 : 409,
            body: metadata.version
              ? {
                  ...choice,
                  status: "active",
                  version: metadata.version,
                  url: entryUrl ?? "assistant/",
                }
              : { detail: "assistant is not ready" },
          },
        ]
      : []),
  ];
  return responses
    .flatMap(({ path, status, body }) =>
      [path, `${path}/`].map(
        (route) => `
    location = ${nginxQuoted(route, "assistant API path")} {
      default_type application/json;
      add_header Cache-Control "no-store" always;
      add_header Access-Control-Allow-Origin $cadet_app_origin always;
      add_header Access-Control-Allow-Credentials "true" always;
      add_header Access-Control-Allow-Methods "GET, HEAD, OPTIONS" always;
      add_header Access-Control-Allow-Headers "Accept, Cadet-Organization-Id" always;
      add_header Vary "Origin" always;
      if ($request_method = OPTIONS) { return 204; }
      if ($request_method !~ ^(GET|HEAD)$) { return 405; }
      return ${status} ${nginxQuoted(JSON.stringify(body), "assistant metadata")};
    }`,
      ),
    )
    .join("\n");
}

/** Build the nginx config for the app server and its public assistant metadata.
 *  Not in the module's public surface: production callers go through
 *  `startAppServer`. Exported for tests
 *  (cli/src/__tests__/nginx.test.ts), which assert on the generated text. */
export function buildNginxConfig(opts: {
  /** Where the edge proxies gateway traffic — `getGatewayUrl` of the entry the edge fronts. */
  gatewayUrl: string;
  listenPort: number;
  /**
   * Serve the web + app-shell bundles with the injected config instead of
   * proxying the gateway flat: pass the bundles' dist dirs and the config
   * the documents carry. The app-shell bundle is the outer account/client
   * shell from the origin root; the web SPA is iframed from
   * /web/assistant/. The index paths default to each bundle's own index;
   * the start path points them at the ingress dir, where the injected
   * copies are written.
   */
  config?: InjectedConfig;
  webDistDir?: string;
  appDistDir?: string;
  indexHtmlPath?: string;
  appIndexHtmlPath?: string;
  /** Emit the `[::1]` listener. Off where the host has no IPv6 loopback,
   *  since nginx exits at startup when it cannot bind a listen address. */
  ipv6Loopback?: boolean;
}): string {
  const proxyBlock = gatewayProxyBlock(opts.gatewayUrl);
  // A tunnel agent pointed at "localhost" reaches ::1 first on macOS, so an
  // IPv4-only bind refuses whichever share of a burst resolves that way.
  const ipv6Listen = opts.ipv6Loopback
    ? `    listen [::1]:${opts.listenPort};\n`
    : "";
  const { config, webDistDir, appDistDir } = opts;
  const allowedOrigins = config ? appOrigins(config) : [];
  const serverLocations = config
    ? buildRemoteWebIngressLocations({
        gatewayUrl: opts.gatewayUrl,
        webDistDir: webDistDir!,
        appDistDir: appDistDir!,
        indexHtmlPath: opts.indexHtmlPath,
        appIndexHtmlPath: opts.appIndexHtmlPath,
        config,
      })
    : `${DENYLIST_LOCATIONS}

    location / {
${proxyBlock}
    }`;

  return `
worker_processes 1;
error_log stderr;
pid nginx.pid;

events {}

http {
  access_log off;
  default_type application/octet-stream;

  # Compression tuning only. It stays inert here because nginx ships with
  # gzip off, and only the static SPA locations below turn it on: this server
  # also proxies authenticated /v1 and /webhooks traffic, and compressing a
  # response that carries both a secret and attacker-influenced content over
  # TLS is the BREACH side channel. The SPA bytes are the whole win, so the
  # boundary is drawn by opting locations in rather than by excluding proxies.
  # text/html is always compressed once gzip is on, so it must not be
  # repeated in gzip_types.
  gzip_vary on;
  gzip_comp_level 5;
  gzip_min_length 1024;
  gzip_types application/javascript application/json application/wasm image/svg+xml text/css text/plain;

  types {
    application/javascript js mjs;
    application/json json map;
    application/wasm wasm;
    font/woff woff;
    font/woff2 woff2;
    image/gif gif;
    image/jpeg jpeg jpg;
    image/png png;
    image/svg+xml svg svgz;
    image/webp webp;
    image/x-icon ico;
    text/css css;
    text/html html htm;
    text/plain txt;
  }

  map $http_origin $cadet_app_origin {
    default "";
${allowedOrigins.map((origin) => `    ${nginxQuoted(origin, "app origin")} ${nginxQuoted(origin, "app origin")};`).join("\n")}
  }

  map $http_upgrade $connection_upgrade {
    default upgrade;
    "" close;
  }

  # Edge-observed client address, stamped onto every proxied request as
  # X-Cadet-Client-Ip. proxy_set_header overwrites any inbound value, so a
  # remote client cannot smuggle one. Every caller reaches this loopback-only
  # listener through the TLS-terminating front (tunnel agent), so the raw peer
  # is always 127.0.0.1; the front records the real client as the RIGHTMOST
  # X-Forwarded-For entry (tunnel providers append one; tailscale serve sets it),
  # which the remote client cannot control. Fall back to the raw peer when the
  # front sets no X-Forwarded-For.
  map $http_x_forwarded_for $cadet_edge_client_ip {
    default $remote_addr;
    "~,?\\s*(?<cadet_last_xff>[^,\\s]+)\\s*$" $cadet_last_xff;
  }

  server {
    listen 127.0.0.1:${opts.listenPort};
${ipv6Listen}    client_max_body_size 512m;

    # This edge sits behind a TLS-terminating front (tunnel or tailscale serve),
    # so redirects must be relative: emit "Location: /assistant/" and let the
    # client resolve it against the origin it used, rather than an absolute URL
    # built from nginx's own loopback scheme and port.
    absolute_redirect off;
    port_in_redirect off;

${serverLocations}
  }
}
`;
}

/**
 * The unversioned gateway API surface (P7 of the one-url plan): the edge
 * forwards every path it does not serve itself to the gateway, whose router
 * resolves an optional /v1 prefix — no per-route enumeration. The lookaheads
 * spare only the edge's OWN surface: the /web twin hands the iframe
 * namespace's remainder to the same /v1 translation the ^~ /web/v1/ location
 * does, and the root forward excludes the app shell's routes and shipped
 * root files (the edge's other prefixes — v1, webhooks, assets, assistant —
 * are already claimed by exact or ^~ prefix locations, which pre-empt regex
 * matching). The twin is emitted first so /web paths reach it, not the root
 * catch-all; the denylist's exact blocks always win over both.
 */
function unversionedGatewayForwardLocations(gatewayUrl: string): string {
  const proxyBlock = gatewayProxyBlock(gatewayUrl);
  return `    # The unversioned gateway API surface (P7): forwarded verbatim — the
    # gateway's router resolves the /v1 prefix.
    location ~ ^/web/(?!assistant(?:/|$)|v1(?:/|$)) {
      rewrite ^/web/(.*)$ /v1/$1 break;
${proxyBlock}
    }

    location ~ ^/(?!account(?:/|$)|logout(?:/|$)|index\\.html$|favicon\\.svg$|cadet-logo-white\\.svg$|cadet-scene-cut\\.mp4$) {
${proxyBlock}
    }`;
}

/**
 * Gateway-facing locations shared by both shell modes: liveness probes and
 * the runtime API surface, all proxied verbatim.
 */
function gatewayProxyLocations(gatewayUrl: string): string {
  const proxyBlock = gatewayProxyBlock(gatewayUrl);
  return `    location = /healthz {
${proxyBlock}
    }

    location = /readyz {
${proxyBlock}
    }

    location ^~ /v1/ {
${proxyBlock}
    }

    location ^~ /webhooks/ {
${proxyBlock}
    }`;
}

/**
 * Serve the web SPA from one path prefix: the exact-mount rewrites, the
 * injected index, the inline config, and the SPA fallback. Used for the
 * /assistant/ mount in web mode and the /web/assistant/ iframe mount in
 * app mode. `prefix` carries both a leading and trailing slash.
 */
function webSpaLocations(opts: {
  prefix: string;
  webDistDir: string;
  indexHtmlPath: string;
  config: Record<string, unknown>;
}): string {
  const indexHtmlPath = opts.indexHtmlPath;
  const configJson = JSON.stringify(opts.config);
  const prefix = opts.prefix.replace(/\/+$/, "");
  return `    location = ${prefix} {
      return 302 ${prefix}/;
    }

    location = ${prefix}/ {
      rewrite ^ ${prefix}/__remote-index.html last;
    }

    location = ${prefix}/index.html {
      rewrite ^ ${prefix}/__remote-index.html last;
    }

    # The shell and the unhashed files beside it revalidate rather than
    # refusing storage: they carry no credential, and nginx serves them from
    # disk with a validator, so a repeat load costs a 304 instead of the whole
    # document. __config is the exception below: it is returned inline, so
    # nginx attaches no validator for a revalidation to match against.
    location = ${prefix}/__remote-index.html {
      internal;
      gzip on;
      alias ${nginxQuoted(indexHtmlPath, "remote web ingress index path")};
      add_header Cache-Control "no-cache";
    }

    location = ${prefix}/__config {
      default_type application/json;
      add_header Cache-Control "no-store";
      return 200 ${nginxQuoted(configJson, "remote web ingress config")};
    }

    location ^~ ${prefix}/ {
      gzip on;
      alias ${nginxQuoted(nginxDirPath(opts.webDistDir), "web dist path")};
      try_files $uri $uri/ ${prefix}/__remote-index.html;
      add_header Cache-Control "no-cache";
    }`;
}

/** The web bundle's hashed chunks, cached immutably under its dist root. */
function webAssetsLocations(webDistDir: string): string {
  return `    location ^~ /assistant/assets/ {
      gzip on;
      alias ${nginxQuoted(
        nginxDirPath(join(webDistDir, "assets")),
        "web assets path",
      )};
      try_files $uri =404;
      add_header Cache-Control "public, max-age=31536000, immutable";
    }`;
}

function buildRemoteWebIngressLocations(opts: {
  gatewayUrl: string;
  webDistDir: string;
  appDistDir: string;
  appIndexHtmlPath?: string;
  indexHtmlPath?: string;
  config: Record<string, unknown>;
}): string {
  const webDistDir = nginxDirPath(opts.webDistDir);
  const indexHtmlPath =
    opts.indexHtmlPath ?? join(opts.webDistDir, "index.html");

  // The app bundle is the outer shell (origin root, including the
  // app's own /assistant/* host routes) and the web SPA is iframed from the
  // distinct /web/assistant/ namespace, so neither surface can load the
  // other recursively. The web bundle's asset URLs keep their baked
  // /assistant/ base, so its hashed chunks and public files stay served
  // under that prefix even though the document now mounts from /web/.
  const appIndexHtmlPath =
    opts.appIndexHtmlPath ?? join(opts.appDistDir, "index.html");
  return `${denylistLocations()}

${denylistLocations("/web")}

${assistantMetadataLocations({
  ...opts.config,
  entryUrl: ASSISTANT_ENTRY_URL,
})}

${gatewayProxyLocations(opts.gatewayUrl)}

${unversionedGatewayForwardLocations(opts.gatewayUrl)}

    location ^~ /web/v1/ {
${gatewayProxyBlock(opts.gatewayUrl, "/v1/")}
    }

${webSpaLocations({
  prefix: "/web/assistant",
  webDistDir: opts.webDistDir,
  indexHtmlPath,
  config: opts.config,
})}

    location = /web {
      return 302 /web/assistant/;
    }

    # The web bundle's hashed chunks and unhashed public files under its baked
    # build base. Real files win; anything else falls through to the app
    # shell, which owns the /assistant/* host routes.
    location = /assistant {
      rewrite ^ /__cadet-app-index.html last;
    }

    location = /assistant/ {
      rewrite ^ /__cadet-app-index.html last;
    }

${webAssetsLocations(opts.webDistDir)}

    location ^~ /assistant/ {
      gzip on;
      alias ${nginxQuoted(webDistDir, "web dist path")};
      try_files $uri @cadet_app_shell;
      add_header Cache-Control "no-cache";
    }

    # The app shell: its document is the config-injected standalone index, and
    # every shell route (/, /account/*, /logout, and the /assistant/* host
    # routes) resolves through the SPA fallback.
    location = /__cadet-app-index.html {
      internal;
      gzip on;
      alias ${nginxQuoted(appIndexHtmlPath, "app shell ingress index path")};
      add_header Cache-Control "no-cache";
    }

    location @cadet_app_shell {
      rewrite ^ /__cadet-app-index.html last;
    }

    location = / {
      rewrite ^ /__cadet-app-index.html last;
    }

    location ^~ /assets/ {
      gzip on;
      alias ${nginxQuoted(
        nginxDirPath(join(opts.appDistDir, "assets")),
        "app assets path",
      )};
      try_files $uri =404;
      add_header Cache-Control "public, max-age=31536000, immutable";
    }

    location / {
      gzip on;
      alias ${nginxQuoted(nginxDirPath(opts.appDistDir), "app dist path")};
      try_files $uri @cadet_app_shell;
      add_header Cache-Control "no-cache";
    }`;
}

function nginxBin(): string {
  return process.env.NGINX_BIN || "nginx";
}

/**
 * Check whether nginx is installed and accessible.
 * Returns the version string if installed, null otherwise.
 * (nginx prints its version to stderr.)
 */
export function getNginxVersion(): string | null {
  const result = spawnSync(nginxBin(), ["-v"], {
    encoding: "utf-8",
    timeout: 5_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return null;
  const output = `${result.stderr || ""}${result.stdout || ""}`.trim();
  return output || null;
}

/*
 * PID handling is deliberately self-contained rather than reusing the
 * process.ts helpers: stopProcessByPidFile's isCadetProcess() guard only
 * matches command lines containing a cadet path, which fails for a custom
 * CADET_WORKSPACE_DIR and would silently leave nginx running (the same
 * reason local.ts stops the tunnel agent directly). This module is also
 * imported by
 * sleep/retire, whose tests mock.module() process.js process-globally —
 * depending on it here would couple this lib's behavior to those mocks.
 */

function saveIngressState(state: IngressState): void {
  mkdirSync(getIngressPaths().dir, { recursive: true });
  writeFileSync(ingressStatePath(), JSON.stringify(state, null, 2) + "\n");
}

/**
 * The tunnel URL on record (the root lockfile's `tunnel.publicUrl`, stamped
 * by whichever run established the tunnel), or undefined when none is — the
 * served config stamps it as `cloudUrl` so tunnel clients' account/auth
 * surfaces stay on the origin they came in on.
 */
function savedPublicBaseUrl(): string | undefined {
  try {
    const url = readRootProcesses().tunnel?.publicUrl;
    if (!url || !url.trim()) return undefined;
    return url.trim();
  } catch {
    return undefined;
  }
}

export const INGRESS_READY_TIMEOUT_MS = 5_000;

/**
 * Settle budget for the spawned nginx to prove port ownership: a healthy
 * master records its pid under our prefix within milliseconds, while one that
 * lost the bind exits. Bounds the wait for whichever happens first.
 */
// The settle window must outlast nginx's internal bind-retry loop (5 attempts
// with 500ms sleeps) so a contested bind resolves to a child exit rather than
// a timeout while the child is still retrying.
const OWNERSHIP_SETTLE_TIMEOUT_MS = 4_000;
const OWNERSHIP_SETTLE_INTERVAL_MS = 100;

/**
 * Outcome of an attempt to bring up the app server. Callers render their own
 * messaging per variant: `ensureAppServer` maps failure variants to thrown
 * errors with actionable text, which `cadet tunnel` and `cadet app up` print
 * before exiting non-zero while the wake restore path warns and continues.
 */
export type StartAppServerResult =
  | {
      status: "started";
      listenPort: number;
      /** SPA dist directory served by the edge. */
      webDistDir: string;
      version: string;
    }
  | {
      status: "already-running";
      /** Recorded listen port of the running edge (requested port when no state is recorded). */
      listenPort: number;
      /** Recorded gateway upstream; undefined when the record predates the field. */
      gatewayUrl?: string;
      /**
       * Set when the surviving edge matches the requested gateway upstream but
       * serves a different injected SPA config than requested (a restart was
       * attempted and failed), so the served index is stale.
       */
      staleRemoteWebConfig?: true;
    }
  | { status: "nginx-missing" }
  | { status: "web-dist-missing" }
  | { status: "app-dist-missing" }
  | { status: "unreachable"; listenPort: number; logPath: string }
  | { status: "port-conflict"; listenPort: number; logPath: string };

/**
 * Generate the nginx config and start the app server, probe /healthz through
 * it to prove the ingress → gateway path is live, and confirm
 * via the recorded pid file that the spawned nginx owns the listen port. A
 * spawned but unreachable or unowned nginx is rolled back so a failed attempt
 * leaves no half-up edge behind.
 *
 * An edge already running against the requested gateway upstream and serving
 * the requested injected SPA config short-circuits as `already-running`; one
 * against a different gateway upstream, or serving a drifted SPA config (e.g.
 * a renamed assistant or an updated hub URL), is stopped and restarted with
 * the requested config. The edge is assistant-agnostic: it carries no
 * assistant identity in its options — `getGatewayUrl` of the entry it fronts
 * is the routing decision, resolved from the lockfile by the caller.
 *
 * Pure mechanism: it performs no console output and never exits the process, so
 * every edge caller (`cadet tunnel`, `cadet app up`, the wake restore path)
 * can share one implementation and map the returned result to its own UX.
 */
export async function startAppServer(opts: {
  /** Where the edge proxies gateway traffic — `getGatewayUrl` of the fronted entry. */
  gatewayUrl: string;
  /**
   * Serving assistant's id, stamped into the served remote-web config
   * (`__CADET_CONFIG__.assistantId`) so a caller probing this origin can
   * confirm which assistant the edge fronts.
   */
  assistantId: string;
}): Promise<StartAppServerResult> {
  let listenPort = DEFAULT_NGINX_INGRESS_PORT;

  const nginxVersion = getNginxVersion();
  if (!nginxVersion) {
    return { status: "nginx-missing" };
  }

  const running = isIngressRunning();
  const recorded = running ? readIngressState() : null;
  if (recorded) {
    listenPort = recorded.listenPort;
  }
  const { webDistDir, appDistDir } = await resolveEdgeClientDists();
  if (!webDistDir) {
    return { status: "web-dist-missing" };
  }
  if (!appDistDir) {
    return { status: "app-dist-missing" };
  }
  // The edge serves the CLI's own bundles, so the version it stamps answers
  // "which cadet is running this" — the CLI's own stamp, not the gateway
  // runtime's. stampedVersion is stable for a given checkout (the stamp's
  // timestamp is the HEAD commit's), so the fingerprint below never drifts
  // between processes.
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
  const requestedConfigHash = remoteWebConfigFingerprint(
    config,
    webDistDir,
    version,
    appDistDir,
  );
  // A record without a fingerprint predates the field and counts as drifted
  // (see IngressState).
  const configMatches = recorded?.remoteWebConfigHash === requestedConfigHash;
  const alreadyRunning = (): StartAppServerResult => ({
    status: "already-running",
    listenPort: recorded?.listenPort ?? listenPort,
    ...(recorded?.gatewayUrl !== undefined
      ? { gatewayUrl: recorded.gatewayUrl }
      : {}),
    ...(recorded?.gatewayUrl === opts.gatewayUrl && !configMatches
      ? { staleRemoteWebConfig: true as const }
      : {}),
  });
  // An unknown recorded gateway upstream is unverified (see IngressState).
  if (running && recorded?.gatewayUrl === opts.gatewayUrl && configMatches) {
    return alreadyRunning();
  }

  // The running edge targets a different gateway upstream or injects a stale
  // SPA config; restart it with the requested config. A false stop can mean
  // the old edge exited on its own after the
  // check above, so recheck liveness and only bail when it is still serving.
  if (running && !(await stopIngressNginx()) && isIngressRunning()) {
    return alreadyRunning();
  }

  // A foreign process squatting the default edge port (another assistant's
  // edge, a stale dev server) must not kill the tunnel: the edge port is
  // loopback-local and the public tunnel URL never carries it, so moving to
  // the next free port is invisible to remote clients.
  const discovered = await findAvailableServerPort(listenPort);
  if (discovered !== null && discovered !== listenPort) {
    console.log(`Port ${listenPort} in use; using ${discovered} instead.`);
    listenPort = discovered;
  }

  // The edge's private state lives under the XDG data dir (never an
  // assistant workspace): conf, pidfile, and the two index documents the
  // generated locations alias — each injected with the served config, so
  // the edge never serves the build-time vite stamp the dist indexes
  // carry.
  const paths = getIngressPaths();
  mkdirSync(paths.dir, { recursive: true });
  mkdirSync(resolveLogDir(), { recursive: true });
  const indexHtmlPath = join(paths.dir, "assistant-index.html");
  const appIndexHtmlPath = join(paths.dir, "app-index.html");
  const rawIndexHtml = readFileSync(join(webDistDir, "index.html"), "utf-8");
  writeFileSync(indexHtmlPath, buildRemoteWebIndexHtml(rawIndexHtml, config));
  // The app shell gets its own injected document: the same injected config,
  // written beside the web one so the generated locations can alias it
  // internally.
  const rawAppIndexHtml = readFileSync(join(appDistDir, "index.html"), "utf-8");
  writeFileSync(
    appIndexHtmlPath,
    buildRemoteWebIndexHtml(rawAppIndexHtml, config),
  );
  writeFileSync(
    paths.confPath,
    buildNginxConfig({
      gatewayUrl: opts.gatewayUrl,
      listenPort,
      webDistDir,
      appDistDir,
      config,
      indexHtmlPath,
      appIndexHtmlPath,
      ipv6Loopback: hasIpv6Loopback(),
    }),
  );
  const fd = openSync(paths.logPath, "a");
  // nginx runs `daemon off`, so the spawned process is the master and
  // stays alive while the edge serves; it writes its pid to nginx.pid
  // under the prefix dir.
  const child = spawn(
    nginxBin(),
    ["-p", paths.dir, "-c", paths.confPath, "-g", "daemon off;"],
    { detached: true, stdio: ["ignore", fd, fd], windowsHide: true },
  );
  closeSync(fd);
  saveIngressState({
    listenPort,
    gatewayUrl: opts.gatewayUrl,
    remoteWebConfigHash: remoteWebConfigFingerprint(
      config,
      webDistDir,
      version,
      appDistDir,
    ),
  });
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  child.unref();

  // /healthz proxies through nginx to the gateway, so a 200 proves the whole
  // ingress → gateway path works.
  const ready = await waitForDaemonReady(listenPort, INGRESS_READY_TIMEOUT_MS);
  const rollback = async (
    status: "port-conflict" | "unreachable",
  ): Promise<StartAppServerResult> => {
    const { logPath } = getIngressPaths();
    await stopIngressNginx();
    return { status, listenPort, logPath };
  };
  const childExited = (): boolean => exited || child.exitCode !== null;
  // nginx runs `daemon off`, so the spawned process is the master and stays
  // alive while the edge serves. An early exit means startup failed: a dead
  // spawn is reported as a port conflict even when the probe succeeded, since
  // that probe reached some other process bound to the port (e.g. another
  // assistant's edge), not this one.
  if (!ready) {
    return rollback(childExited() ? "port-conflict" : "unreachable");
  }
  // A successful probe alone does not prove ownership either: a healthy edge
  // from another workspace answers /healthz before our master finishes failing
  // its bind. A master that won the bind records its pid under our prefix, so
  // settle-poll until the spawn either exits (lost the bind) or that pid file
  // names a live ingress nginx of ours (owns the port).
  const deadline = Date.now() + OWNERSHIP_SETTLE_TIMEOUT_MS;
  for (;;) {
    if (childExited()) {
      break;
    }
    if (getIngressPid() !== null) {
      return {
        status: "started",
        listenPort,
        webDistDir,
        version: nginxVersion,
      };
    }
    if (Date.now() >= deadline) {
      // The child is alive but never proved ownership. Kill it before rolling
      // back: it may still be inside nginx's bind-retry loop, and an orphan
      // that later wins the bind would serve with no recorded state.
      try {
        child.kill("SIGTERM");
      } catch {
        // Already gone; the rollback below clears any remaining state.
      }
      break;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, OWNERSHIP_SETTLE_INTERVAL_MS),
    );
  }
  return rollback("port-conflict");
}

/**
 * Stop the app server fronting a container assistant, if this assistant is
 * the one it currently fronts.
 *
 * Container topologies share one default-workspace edge (one pidfile, one
 * listen port), so the recorded gateway upstream — `getGatewayUrl` of the
 * entry — is what attributes it. Without that check this would tear down
 * another assistant's working tunnel; a record with no recorded upstream
 * cannot be attributed, so it is left alone.
 */
/** Record the running edge's pid in the root lockfile for `cadet ps`. */
function stampAppProcessEntry(port: number): void {
  const pid = getIngressPid();
  if (pid !== null) {
    stampRootProcess("app", {
      pid,
      startedAt: new Date().toISOString(),
      port,
    });
  }
}

/** Resolved edge a tunnel (or bring-your-own HTTPS front) should target. */
export interface AppServer {
  /** Loopback listen port the HTTPS front should forward to. */
  port: number;
  /** True when this call started the edge, false when a running one was reused. */
  started: boolean;
}

/**
 * Recovery text for a drifted edge that outlived the automatic restart.
 * `startAppServer` already escalated SIGTERM to SIGKILL before
 * reporting `already-running`, so the only thing left is the wedged process
 * itself: name its PID and log so the user can clear it by hand.
 */
function stuckEdgeRecoveryHint(): string {
  const { logPath } = getIngressPaths();
  const pid = getIngressPid();
  const target = pid !== null ? `the nginx process (PID ${pid})` : "it";
  return (
    `Cadet could not stop ${target}, even with SIGKILL. ` +
    `Stop it by hand and retry, or run \`cadet sleep\` to shut the ` +
    `assistant down entirely. Check the nginx log: ${logPath}`
  );
}

/**
 * Bring up the nginx edge as the canonical tunnel target and return the listen
 * port a tunnel should front.
 *
 * The edge is assistant-agnostic: it carries no assistant identity in its
 * options. The assistant it fronts — and with it the gateway it proxies, via
 * `getGatewayUrl` — is resolved from the lockfile here (the active assistant,
 * else the only entry), so every edge caller shares one resolution instead of
 * threading bespoke ids and ports. Its own state (conf, pidfile, recorded
 * upstream) lives under the XDG data dir, never an assistant workspace.
 *
 * The edge always serves the SPA alongside the gateway proxy. It is always
 * delegated to `startAppServer`, which reuses a running edge whose
 * gateway upstream and injected SPA config match and restarts one that
 * drifted in any respect, so the returned port always fronts the requested
 * config. `started` is false when a matching edge was reused; a drifted edge
 * that survives the restart attempt throws rather than reporting the wrong
 * config. Failures throw with actionable install or diagnostic text.
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
      stampAppProcessEntry(result.listenPort);
      return {
        port: result.listenPort,
        started: true,
      };
    case "already-running": {
      // `already-running` also covers a drifted edge whose restart failed, so
      // trust the recorded state it carries over the requested config.
      if (result.gatewayUrl !== gatewayUrl) {
        throw new Error(
          `The nginx edge is still proxying ${result.gatewayUrl ?? "an unknown gateway upstream"} ` +
            `and could not be restarted against ${gatewayUrl}. ` +
            stuckEdgeRecoveryHint(),
        );
      }
      if (result.staleRemoteWebConfig) {
        throw new Error(
          "The nginx edge is still serving an outdated remote web config " +
            "and could not be restarted with the updated one. " +
            stuckEdgeRecoveryHint(),
        );
      }
      stampAppProcessEntry(result.listenPort);
      return {
        port: result.listenPort,
        started: false,
      };
    }
    case "nginx-missing":
      throw new Error(
        "nginx is not installed, so the app server cannot start. " +
          "See https://nginx.org/en/docs/install.html for how to install, " +
          "or point NGINX_BIN at an existing binary.",
      );
    case "web-dist-missing":
      throw new Error(
        "Unable to locate built web assets for the remote web edge. " +
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
        `nginx edge did not become reachable on 127.0.0.1:${result.listenPort}. ` +
          `Check the nginx log: ${result.logPath}`,
      );
    case "port-conflict":
      throw new Error(
        `nginx edge exited on startup, most likely because 127.0.0.1:${result.listenPort} ` +
          "is already in use (for example by another assistant's app server). " +
          "Stop whatever is bound to that port, then retry. " +
          `Check the nginx log: ${result.logPath}`,
      );
  }
}
