import {
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcess,
} from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { cloudAssistantHubUrl } from "@mycadet/environments";

import cliPkg from "../../package.json";
import { stampedVersion } from "@mycadet/shared/version";

import {
  clearAppProcessRecord,
  getAssistantDisplayName,
  lookupAssistantByIdentifier,
  readRootProcesses,
  stampRootProcess,
  type AssistantEntry,
} from "./assistant-config.js";
import { getLoopbackGatewayPort } from "@mycadet/local-mode/contract";
import type { RemoteHost } from "./constants.js";
import { waitForDaemonReady } from "./http-client.js";
import {
  getDefaultWorkspaceDir,
  isLocalContainerEntry,
  loadRawConfig,
  saveRawConfig,
} from "./ingress-config.js";
import { resolveEdgeClientDists } from "./web-dist.js";

export { findWebDistDir } from "./web-dist.js";
export { findAppDistDir } from "./web-dist.js";

/**
 * CLI-managed nginx reverse proxy that fronts the gateway as the canonical
 * tunnel target: browser → tunnel (TLS) → nginx@127.0.0.1 → gateway@127.0.0.1.
 *
 * `cadet tunnel` (and the wake restore path) bring this edge up via
 * `ensureAppServer` and always front its loopback listen port.
 */

export const DEFAULT_NGINX_INGRESS_PORT = 7840;

/** Listen port for nginx ingress, from CADET_NGINX_INGRESS_PORT. */
export function getNginxIngressPort(): number {
  const raw = process.env.CADET_NGINX_INGRESS_PORT;
  if (!raw) return DEFAULT_NGINX_INGRESS_PORT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error("CADET_NGINX_INGRESS_PORT must be a valid TCP port");
  }
  return value;
}

export interface IngressPaths {
  /** nginx prefix dir; conf, pidfile, and temp dirs live here. */
  dir: string;
  confPath: string;
  pidPath: string;
  logPath: string;
}

export function getIngressPaths(workspaceDir: string): IngressPaths {
  const dir = join(workspaceDir, "data", "ingress");
  return {
    dir,
    confPath: join(dir, "nginx.conf"),
    pidPath: join(dir, "nginx.pid"),
    logPath: join(workspaceDir, "data", "logs", "nginx-ingress.log"),
  };
}

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

function gatewayProxyBlock(gatewayPort: number, upstreamPath = ""): string {
  return `      proxy_pass http://127.0.0.1:${gatewayPort}${upstreamPath};
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
 * path is blocked with and without its trailing slash.
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
    return `${block(route)}\n${block(`${route}/`)}`;
  });
  return exact.join("\n");
}

const DENYLIST_LOCATIONS = denylistLocations();

export interface RemoteWebIngressOptions {
  webDistDir: string;
  /**
   * Standalone app-shell bundle: the edge serves it as the outer
   * account/client shell from the origin root and iframes the web SPA from
   * /web/assistant/.
   */
  appDistDir: string;
  /**
   * The config-injected app-shell document. Defaults to the app bundle's own
   * index; the edge start path points this at the ingress dir, where the
   * injected copy is written.
   */
  appIndexHtmlPath?: string;
  indexHtmlPath?: string;
  /** Assistant release verified against the served UI artifact. */
  version?: string;
  config?: Record<string, unknown>;
  /** Serving assistant's display name, stamped into the served config so
   *  remote clients can label this origin. Absent in older served configs. */
  assistantName?: string;
  /** Serving assistant's id, stamped into the served config so a caller can
   *  confirm which assistant an edge is fronting. Absent in older served
   *  configs. */
  assistantId?: string;
  /** Cloud web SPA base the remote client can hand this origin to (see
   *  `cloudAssistantHubUrl`). Absent in older served configs. */
  hubUrl?: string;
}

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
function lockfileAssistantRemote(assistantId: string): string | undefined {
  const result = lookupAssistantByIdentifier(assistantId);
  return result.status === "found" ? result.entry.cloud : undefined;
}

/**
 * The remote kind stamped into the served SPA config. Docker and custom
 * cadets are stamped truthfully; every other hosting shape — a local cadet
 * reached through this edge, paired remotes, unknown entries — reads as
 * "custom" so the served bundle always runs the remote-gateway machinery
 * (this edge serves remote browsers however the cadet itself is hosted).
 * "cloud" is never stamped: the cloud serves its own bundles.
 */
export function edgeServedRemote(recorded: string | undefined): RemoteHost {
  return recorded === "docker" ? "docker" : "custom";
}

function remoteWebIngressConfig(
  opts: Pick<
    RemoteWebIngressOptions,
    "config" | "assistantName" | "assistantId" | "hubUrl" | "version"
  > & { cloudUrl?: string },
): Record<string, unknown> {
  return {
    remote: edgeServedRemote(
      opts.assistantId ? lockfileAssistantRemote(opts.assistantId) : undefined,
    ),
    assistantName: opts.assistantName,
    assistantId: opts.assistantId,
    hubUrl: opts.hubUrl,
    cloudUrl: opts.cloudUrl,
    version: opts.version,
    ...opts.config,
  };
}

/**
 * Part of edge identity: a detached edge is reused only while its recorded
 * fingerprint matches, so this must change whenever the generated index or
 * nginx template does.
 */
export const EDGE_TEMPLATE_VERSION = 14;

/**
 * Stable fingerprint of the injected SPA config, its source bundles, and the
 * template that renders them. Recorded alongside the edge state so a reuse
 * decision can tell whether a running edge already serves the requested
 * config (see `IngressState.remoteWebConfigHash`).
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
        template: EDGE_TEMPLATE_VERSION,
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
export async function findAvailableIngressPort(
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
  appAllowedOrigins: z.array(z.string().url()).default([]),
});

function assistantHostConfig(config: Record<string, unknown>) {
  const result = AssistantHostConfigSchema.safeParse(config);
  if (!result.success) {
    throw new Error("Invalid assistant host configuration.");
  }
  return result.data;
}

function appOrigins(config: Record<string, unknown>): string[] {
  const metadata = assistantHostConfig(config);
  const origins = [
    ...metadata.appAllowedOrigins,
    ...(metadata.hubUrl ? [new URL(metadata.hubUrl).origin] : []),
  ];
  return [...new Set(origins)].map((origin) => {
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

/** Build the nginx config for the app server and its public assistant metadata. */
export function buildIngressNginxConfig(opts: {
  gatewayPort: number;
  listenPort: number;
  remoteWebIngress?: RemoteWebIngressOptions;
  /** Emit the `[::1]` listener. Off where the host has no IPv6 loopback,
   *  since nginx exits at startup when it cannot bind a listen address. */
  ipv6Loopback?: boolean;
}): string {
  const proxyBlock = gatewayProxyBlock(opts.gatewayPort);
  // A tunnel agent pointed at "localhost" reaches ::1 first on macOS, so an
  // IPv4-only bind refuses whichever share of a burst resolves that way.
  const ipv6Listen = opts.ipv6Loopback
    ? `    listen [::1]:${opts.listenPort};\n`
    : "";
  const remoteWebIngress = opts.remoteWebIngress;
  const allowedOrigins = remoteWebIngress
    ? appOrigins(remoteWebIngressConfig(remoteWebIngress))
    : [];
  const serverLocations = remoteWebIngress
    ? buildRemoteWebIngressLocations({
        gatewayPort: opts.gatewayPort,
        webDistDir: remoteWebIngress.webDistDir,
        appDistDir: remoteWebIngress.appDistDir,
        appIndexHtmlPath: remoteWebIngress.appIndexHtmlPath,
        indexHtmlPath: remoteWebIngress.indexHtmlPath,
        config: remoteWebIngressConfig(remoteWebIngress),
        version: remoteWebIngress.version,
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
 * Gateway-facing locations shared by both shell modes: liveness probes and
 * the runtime API surface, all proxied verbatim.
 */
function gatewayProxyLocations(gatewayPort: number): string {
  const proxyBlock = gatewayProxyBlock(gatewayPort);
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
  gatewayPort: number;
  webDistDir: string;
  appDistDir: string;
  appIndexHtmlPath?: string;
  indexHtmlPath?: string;
  config: Record<string, unknown>;
  version?: string;
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
  version: opts.version,
  entryUrl: ASSISTANT_ENTRY_URL,
})}

${gatewayProxyLocations(opts.gatewayPort)}

    location ^~ /web/v1/ {
${gatewayProxyBlock(opts.gatewayPort, "/v1/")}
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

    # The iframe namespace has no other routes: anything under /web that is
    # not the assistant mount or its prefixed API path is a probe, not a page.
    location ^~ /web/ {
      return 404;
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

function readPidFile(pidPath: string): number | null {
  try {
    const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check whether a PID belongs to this ingress nginx process.
 *
 * Matching only the executable name is not enough: a stale pidfile can point
 * at a system nginx or another assistant's ingress after PID reuse.
 */
function isIngressNginxProcess(pid: number, paths: IngressPaths): boolean {
  try {
    const output = execFileSync(
      "ps",
      ["-ww", "-p", String(pid), "-o", "command="],
      {
        encoding: "utf-8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      },
    ).trim();
    return (
      /nginx/.test(output) &&
      output.includes(paths.dir) &&
      output.includes(paths.confPath)
    );
  } catch {
    return false;
  }
}

/** The ingress nginx PID when it is recorded and alive, null otherwise. */
export function getIngressPid(workspaceDir: string): number | null {
  const paths = getIngressPaths(workspaceDir);
  const pid = readPidFile(paths.pidPath);
  return pid !== null && isPidAlive(pid) && isIngressNginxProcess(pid, paths)
    ? pid
    : null;
}

export function isIngressRunning(workspaceDir: string): boolean {
  return getIngressPid(workspaceDir) !== null;
}

export interface IngressState {
  listenPort: number;
  /**
   * Gateway port the edge's proxy_pass targets. Undefined in state records
   * that predate the field; callers treat an unknown port as unverified and
   * restart the edge so the running config provably targets the requested
   * port and the state is stamped for future comparisons.
   */
  gatewayPort?: number;
  /**
   * Fingerprint of the injected SPA config and its source bundle. Undefined
   * for records that predate the field; an edge without a recorded
   * fingerprint is treated as drifted and restarted so the served index
   * provably carries the requested config.
   */
  remoteWebConfigHash?: string;
}

export function readIngressState(workspaceDir: string): IngressState | null {
  const config = loadRawConfig(workspaceDir);
  const ingress = config.ingress as Record<string, unknown> | undefined;
  const nginx = ingress?.nginx as Record<string, unknown> | undefined;
  const listenPort = nginx?.listenPort;
  if (typeof listenPort !== "number") return null;
  const gatewayPort = nginx?.gatewayPort;
  const remoteWebConfigHash = nginx?.remoteWebConfigHash;
  return {
    listenPort,
    ...(typeof gatewayPort === "number" ? { gatewayPort } : {}),
    ...(typeof remoteWebConfigHash === "string" ? { remoteWebConfigHash } : {}),
  };
}

function saveIngressState(workspaceDir: string, state: IngressState): void {
  const config = loadRawConfig(workspaceDir);
  const ingress = (config.ingress ?? {}) as Record<string, unknown>;
  ingress.nginx = {
    listenPort: state.listenPort,
    ...(state.gatewayPort !== undefined
      ? { gatewayPort: state.gatewayPort }
      : {}),
    ...(state.remoteWebConfigHash !== undefined
      ? { remoteWebConfigHash: state.remoteWebConfigHash }
      : {}),
  };
  config.ingress = ingress;
  saveRawConfig(workspaceDir, config);
}

function clearIngressState(workspaceDir: string): void {
  const config = loadRawConfig(workspaceDir);
  const ingress = config.ingress as Record<string, unknown> | undefined;
  if (!ingress) return;
  delete ingress.nginx;
  saveRawConfig(workspaceDir, config);
}

function clearStoppedIngress(workspaceDir: string, pidPath: string): void {
  clearIngressState(workspaceDir);
  rmSync(pidPath, { force: true });
  // The edge is gone; release the root lockfile's process entry with it.
  // Its built-sha stamp survives (a build-cache fact, not a process fact)
  // so restarting the edge never pays a needless bundle rebuild.
  clearAppProcessRecord();
}

/**
 * The tunnel URL on record for this workspace (`ingress.publicBaseUrl`, saved
 * when a tunnel established), or undefined when none is — the served config
 * stamps it as `cloudUrl` so tunnel clients' account/auth surfaces stay on
 * the origin they came in on.
 */
function savedPublicBaseUrl(workspaceDir: string): string | undefined {
  try {
    const config = loadRawConfig(workspaceDir);
    const ingress = config.ingress as Record<string, unknown> | undefined;
    const url = ingress?.publicBaseUrl;
    if (typeof url !== "string" || !url.trim()) return undefined;
    return url.trim();
  } catch {
    return undefined;
  }
}

/**
 * Write the nginx config and spawn nginx detached (stdout/stderr to a log
 * file, fd closed after spawn, caller unrefs). nginx runs with `daemon off`
 * so the spawned process is the master; it writes its pid to nginx.pid under
 * the prefix dir.
 */
export function startIngressNginx(opts: {
  workspaceDir: string;
  gatewayPort: number;
  listenPort: number;
  remoteWebIngress?: RemoteWebIngressOptions;
}): ChildProcess {
  const paths = getIngressPaths(opts.workspaceDir);
  mkdirSync(paths.dir, { recursive: true });
  mkdirSync(join(opts.workspaceDir, "data", "logs"), { recursive: true });
  const remoteWebIngress = opts.remoteWebIngress
    ? {
        ...opts.remoteWebIngress,
        config: remoteWebIngressConfig(opts.remoteWebIngress),
        indexHtmlPath: join(paths.dir, "assistant-index.html"),
        // The app shell's own injected document — written below, and wired
        // here so the generated location aliases THIS copy instead of the
        // raw dist index (which carries the build-time vite stamp instead
        // of the edge's served config).
        appIndexHtmlPath: join(paths.dir, "app-index.html"),
      }
    : undefined;
  if (remoteWebIngress) {
    const rawIndexHtml = readFileSync(
      join(remoteWebIngress.webDistDir, "index.html"),
      "utf-8",
    );
    writeFileSync(
      remoteWebIngress.indexHtmlPath,
      buildRemoteWebIndexHtml(rawIndexHtml, remoteWebIngress.config),
    );
    // The app shell gets its own injected document: the same remote-web
    // config, written beside the web one so the generated locations can
    // alias it internally.
    const rawAppIndexHtml = readFileSync(
      join(remoteWebIngress.appDistDir, "index.html"),
      "utf-8",
    );
    writeFileSync(
      join(paths.dir, "app-index.html"),
      buildRemoteWebIndexHtml(rawAppIndexHtml, remoteWebIngress.config),
    );
  }
  writeFileSync(
    paths.confPath,
    buildIngressNginxConfig({
      gatewayPort: opts.gatewayPort,
      listenPort: opts.listenPort,
      remoteWebIngress,
      ipv6Loopback: hasIpv6Loopback(),
    }),
  );

  const fd = openSync(paths.logPath, "a");
  const child = spawn(
    nginxBin(),
    ["-p", paths.dir, "-c", paths.confPath, "-g", "daemon off;"],
    { detached: true, stdio: ["ignore", fd, fd], windowsHide: true },
  );
  closeSync(fd);

  saveIngressState(opts.workspaceDir, {
    listenPort: opts.listenPort,
    gatewayPort: opts.gatewayPort,
    ...(remoteWebIngress
      ? {
          remoteWebConfigHash: remoteWebConfigFingerprint(
            remoteWebIngress.config,
            remoteWebIngress.webDistDir,
            remoteWebIngress.version,
            remoteWebIngress.appDistDir,
          ),
        }
      : {}),
  });
  return child;
}

const STOP_TIMEOUT_MS = 2_000;

async function waitForPidExit(
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !isPidAlive(pid);
}

/**
 * Stop a running ingress nginx via its pidfile and clear the recorded state.
 * Returns true if a process was stopped.
 *
 * Verifies the PID still belongs to this ingress nginx before killing to avoid
 * hitting an unrelated process if the OS has reused the PID. SIGTERM is nginx
 * fast shutdown; escalate to SIGKILL if it doesn't exit within the timeout.
 */
export async function stopIngressNginx(workspaceDir: string): Promise<boolean> {
  const paths = getIngressPaths(workspaceDir);

  const pid = readPidFile(paths.pidPath);
  if (pid === null || !isPidAlive(pid) || !isIngressNginxProcess(pid, paths)) {
    clearStoppedIngress(workspaceDir, paths.pidPath);
    return false;
  }

  try {
    process.kill(pid, "SIGTERM");
    if (!(await waitForPidExit(pid, STOP_TIMEOUT_MS))) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        if (!isPidAlive(pid)) {
          clearStoppedIngress(workspaceDir, paths.pidPath);
          return true;
        }
        return false;
      }
      if (!(await waitForPidExit(pid, STOP_TIMEOUT_MS))) {
        return false;
      }
    }
  } catch {
    if (!isPidAlive(pid)) {
      clearStoppedIngress(workspaceDir, paths.pidPath);
      return true;
    }
    return false;
  }

  clearStoppedIngress(workspaceDir, paths.pidPath);
  return true;
}

/** Probe budget for confirming the freshly-spawned edge answers /healthz. */
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
 * Outcome of an attempt to bring up the nginx ingress edge. Callers render
 * their own messaging per variant: `ensureAppServer` maps failure variants to
 * thrown errors with actionable text, which `cadet tunnel` and
 * `nginx-ingress up` print before exiting non-zero while the wake restore path
 * warns and continues.
 */
export type StartRemoteWebIngressResult =
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
      gatewayPort?: number;
      /**
       * Set when the surviving edge matches the requested gateway port but
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
 * Generate the nginx config and start the remote-web ingress edge, probe
 * /healthz through it to prove the ingress → gateway path is live, and confirm
 * via the recorded pid file that the spawned nginx owns the listen port. A
 * spawned but unreachable or unowned nginx is rolled back so a failed attempt
 * leaves no half-up edge behind.
 *
 * An edge already running against the requested gateway port and serving the
 * requested injected SPA config short-circuits as `already-running`; one
 * against a different gateway port, or serving a drifted SPA config (e.g. a
 * renamed assistant or an updated hub URL), is stopped and restarted with the
 * requested config.
 *
 * Pure mechanism: it performs no console output and never exits the process, so
 * every edge caller (`cadet tunnel`, `nginx-ingress up`, the wake restore
 * path) can share one implementation and map the returned result to its own UX.
 */
export async function startRemoteWebIngress(opts: {
  workspaceDir: string;
  gatewayPort: number;
  listenPort?: number;
  readyTimeoutMs?: number;
  /**
   * Serving assistant's display name, stamped into the served remote-web
   * config (`__CADET_CONFIG__.assistantName`) so remote clients can label
   * this origin. Omitted when unknown; consumers tolerate its absence.
   */
  assistantName?: string;
  /**
   * Serving assistant's id, stamped into the served remote-web config
   * (`__CADET_CONFIG__.assistantId`) so a caller probing this origin can
   * confirm which assistant the edge fronts. Omitted when unknown.
   */
  assistantId?: string;
  /**
   * Invoked once, after every preflight check passes and immediately before
   * nginx is spawned, so callers can emit their own "starting" progress line
   * with the resolved version/dist/port. Never fires on a preflight bail-out
   * (nginx-missing, already-running, web-dist-missing).
   */
  onStarting?: (info: {
    version: string;
    webDistDir: string;
    listenPort: number;
  }) => void;
}): Promise<StartRemoteWebIngressResult> {
  let listenPort = opts.listenPort ?? getNginxIngressPort();

  const nginxVersion = getNginxVersion();
  if (!nginxVersion) {
    return { status: "nginx-missing" };
  }

  const running = isIngressRunning(opts.workspaceDir);
  const recorded = running ? readIngressState(opts.workspaceDir) : null;
  if (
    recorded &&
    opts.listenPort === undefined &&
    process.env.CADET_NGINX_INGRESS_PORT === undefined
  ) {
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
  const version = stampedVersion(cliPkg.version);
  const spaOptions = {
    hubUrl: cloudAssistantHubUrl(),
    assistantName: opts.assistantName,
    assistantId: opts.assistantId,
    version,
    cloudUrl: savedPublicBaseUrl(opts.workspaceDir),
  };
  const requestedConfigHash = remoteWebConfigFingerprint(
    remoteWebIngressConfig(spaOptions),
    webDistDir,
    version,
    appDistDir,
  );
  // A record without a fingerprint predates the field and counts as drifted
  // (see IngressState).
  const configMatches = recorded?.remoteWebConfigHash === requestedConfigHash;
  const alreadyRunning = (): StartRemoteWebIngressResult => ({
    status: "already-running",
    listenPort: recorded?.listenPort ?? listenPort,
    ...(recorded?.gatewayPort !== undefined
      ? { gatewayPort: recorded.gatewayPort }
      : {}),
    ...(recorded?.gatewayPort === opts.gatewayPort && !configMatches
      ? { staleRemoteWebConfig: true as const }
      : {}),
  });
  // An unknown recorded gateway port is unverified (see IngressState).
  if (running && recorded?.gatewayPort === opts.gatewayPort && configMatches) {
    return alreadyRunning();
  }

  // The running edge targets a different gateway port or injects a stale
  // SPA config; restart it with the requested config. A false stop can mean
  // the old edge exited on its own after the
  // check above, so recheck liveness and only bail when it is still serving.
  if (
    running &&
    !(await stopIngressNginx(opts.workspaceDir)) &&
    isIngressRunning(opts.workspaceDir)
  ) {
    return alreadyRunning();
  }

  // A foreign process squatting the default edge port (another assistant's
  // edge, a stale dev server) must not kill the tunnel: the edge port is
  // loopback-local and the public tunnel URL never carries it, so moving to
  // the next free port is invisible to remote clients. Explicit pins
  // (opts.listenPort / CADET_NGINX_INGRESS_PORT) keep their intent and still
  // fail on a collision.
  if (
    opts.listenPort === undefined &&
    process.env.CADET_NGINX_INGRESS_PORT === undefined
  ) {
    const discovered = await findAvailableIngressPort(listenPort);
    if (discovered !== null && discovered !== listenPort) {
      console.log(`Port ${listenPort} in use; using ${discovered} instead.`);
      listenPort = discovered;
    }
  }

  opts.onStarting?.({ version: nginxVersion, webDistDir, listenPort });

  const child = startIngressNginx({
    workspaceDir: opts.workspaceDir,
    gatewayPort: opts.gatewayPort,
    listenPort,
    remoteWebIngress: {
      webDistDir,
      ...spaOptions,
      appDistDir,
    },
  });
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  child.unref();

  // /healthz proxies through nginx to the gateway, so a 200 proves the whole
  // ingress → gateway path works.
  const ready = await waitForDaemonReady(
    listenPort,
    opts.readyTimeoutMs ?? INGRESS_READY_TIMEOUT_MS,
  );
  const rollback = async (
    status: "port-conflict" | "unreachable",
  ): Promise<StartRemoteWebIngressResult> => {
    const { logPath } = getIngressPaths(opts.workspaceDir);
    await stopIngressNginx(opts.workspaceDir);
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
    if (getIngressPid(opts.workspaceDir) !== null) {
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
 * Display name recorded for the assistant in the CLI lockfile; undefined when
 * no entry matches, so the served config omits the label rather than guessing.
 */
function lockfileAssistantName(assistantId: string): string | undefined {
  const result = lookupAssistantByIdentifier(assistantId);
  return result.status === "found"
    ? getAssistantDisplayName(result.entry)
    : undefined;
}

/**
 * Stop the app server fronting a container assistant, if this assistant is
 * the one it currently fronts.
 *
 * Container topologies share one default-workspace edge (one pidfile, one
 * listen port), so the recorded `gatewayPort` is what attributes it. Without
 * that check this would tear down another assistant's working tunnel; a record
 * with no recorded port cannot be attributed, so it is left alone.
 */
export async function stopContainerAppServer(
  entry: AssistantEntry,
): Promise<boolean> {
  if (!isLocalContainerEntry(entry)) {
    return false;
  }
  const gatewayPort = getLoopbackGatewayPort(entry);
  if (gatewayPort === undefined) {
    return false;
  }
  const workspaceDir = getDefaultWorkspaceDir();
  if (!isIngressRunning(workspaceDir)) {
    return false;
  }
  if (readIngressState(workspaceDir)?.gatewayPort !== gatewayPort) {
    return false;
  }
  return stopIngressNginx(workspaceDir);
}

/** Record the running edge's pid in the root lockfile for `cadet ps`. */
function stampAppProcessEntry(
  workspaceDir: string,
  assistantId?: string,
  port = getNginxIngressPort(),
): void {
  const pid = getIngressPid(workspaceDir);
  if (pid !== null) {
    // Carry the built-sha stamp forward: it predates this process entry
    // (it survives the edge's own stop) and must not be wiped by the stamp.
    const builtSha = readRootProcesses().app?.builtSha;
    stampRootProcess("app", {
      pid,
      startedAt: new Date().toISOString(),
      assistantId,
      port,
      ...(builtSha !== undefined ? { builtSha } : {}),
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
 * `startRemoteWebIngress` already escalated SIGTERM to SIGKILL before
 * reporting `already-running`, so the only thing left is the wedged process
 * itself: name its PID and log so the user can clear it by hand.
 */
function stuckEdgeRecoveryHint(workspaceDir: string): string {
  const { logPath } = getIngressPaths(workspaceDir);
  const pid = getIngressPid(workspaceDir);
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
 * The edge always serves the SPA alongside the gateway proxy. It is always
 * delegated to `startRemoteWebIngress`, which reuses a running edge whose
 * gateway port and injected SPA config match and restarts one that drifted in
 * any respect, so the returned port always fronts the requested config.
 * `started` is false when a matching edge was reused; a drifted edge that
 * survives the restart attempt throws rather than reporting the wrong config.
 * Failures throw with actionable install or diagnostic text.
 */
export async function ensureAppServer(opts: {
  assistantId: string | undefined;
  workspaceDir: string;
  gatewayPort: number;
  /** Forwarded to `startRemoteWebIngress` for caller progress output. */
  onStarting?: (info: {
    version: string;
    webDistDir: string;
    listenPort: number;
  }) => void;
}): Promise<AppServer> {
  const assistantName = opts.assistantId
    ? lockfileAssistantName(opts.assistantId)
    : undefined;
  const result = await startRemoteWebIngress({
    workspaceDir: opts.workspaceDir,
    gatewayPort: opts.gatewayPort,
    ...(assistantName ? { assistantName } : {}),
    ...(opts.assistantId ? { assistantId: opts.assistantId } : {}),
    ...(opts.onStarting ? { onStarting: opts.onStarting } : {}),
  });

  switch (result.status) {
    case "started":
      stampAppProcessEntry(
        opts.workspaceDir,
        opts.assistantId,
        result.listenPort,
      );
      return {
        port: result.listenPort,
        started: true,
      };
    case "already-running": {
      // `already-running` also covers a drifted edge whose restart failed, so
      // trust the recorded state it carries over the requested config.
      if (result.gatewayPort !== opts.gatewayPort) {
        const upstream =
          result.gatewayPort !== undefined
            ? `still proxying gateway port ${result.gatewayPort}`
            : "proxying an unknown gateway port";
        throw new Error(
          `The nginx edge is ${upstream} ` +
            `and could not be restarted against port ${opts.gatewayPort}. ` +
            stuckEdgeRecoveryHint(opts.workspaceDir),
        );
      }
      if (result.staleRemoteWebConfig) {
        throw new Error(
          "The nginx edge is still serving an outdated remote web config " +
            "and could not be restarted with the updated one. " +
            stuckEdgeRecoveryHint(opts.workspaceDir),
        );
      }
      stampAppProcessEntry(
        opts.workspaceDir,
        opts.assistantId,
        result.listenPort,
      );
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
          "Stop whatever is bound to that port, or pick a different edge port by " +
          "setting the CADET_NGINX_INGRESS_PORT environment variable, then retry. " +
          `Check the nginx log: ${result.logPath}`,
      );
  }
}
