/**
 * The app server primitive — the server-kind-agnostic half of the app
 * server: its machine-level state (pidfile, serve spec, stop), the start
 * and reuse machinery, and the resolved-server contract the tunnel fronts.
 * The serve implementation — the request handler, the static surface, the
 * websocket relay — lives in the sibling `bun.ts`; this module launches that
 * child by path (a URL reference, not an import, so the dependency graph
 * stays one-directional: bun -> common) and shares every contract with it.
 */

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { cloudAssistantHubUrl } from "@mycadet/environments";

import { resolveVersion } from "@mycadet/shared/version";

import {
  readRootProcesses,
  resolveTargetAssistant,
  stampRootProcess,
} from "../assistant-config.js";
import {
  clearAppProcessRecord,
  getAssistantDisplayName,
  lookupAssistantByIdentifier,
  probePort,
  resolveConfigDir,
  resolveDataDir,
  resolveLogDir,
  waitForDaemonReady,
} from "@mycadet/local-mode";
import {
  getGatewayUrl,
  type InjectedConfig,
} from "@mycadet/local-mode/contract";
import { resolveClientDists } from "../web-dist.js";

export const DEFAULT_APP_SERVER_PORT = 7840;

/**
 * The machine-level state: the pidfile, the serve spec, and the injected
 * documents live under the environment's XDG dirs — the serve data under the
 * data dir, the PID under the config dir — never inside an assistant's
 * workspace, so workspace backups never carry process artifacts.
 */
export interface AppServerPaths {
  /** State dir; the serve spec and the injected indexes live here. */
  dir: string;
  pidPath: string;
  logPath: string;
}

/** The dir pre-rename installs recorded state under (read as a fallback). */
const LEGACY_INGRESS_DIR = "ingress";

export function getAppServerPaths(): AppServerPaths {
  const dir = join(resolveDataDir(), "app-server");
  return {
    dir,
    pidPath: join(resolveConfigDir(), "app-server.pid"),
    logPath: join(resolveLogDir(), "app-server.log"),
  };
}

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
 * Check whether a PID belongs to this app server process.
 *
 * Matching only the executable name is not enough: a stale pidfile can point
 * at another assistant's app server after PID reuse. The serve entry runs as
 * its own script, so its command line names our state dir.
 */
function isAppServerProcess(pid: number, paths: AppServerPaths): boolean {
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
    return output.includes(paths.dir);
  } catch {
    return false;
  }
}

/** The app server's PID when it is recorded and alive, null otherwise. */
export function getAppServerPid(): number | null {
  const paths = getAppServerPaths();
  const pid = readPidFile(paths.pidPath);
  return pid !== null && isPidAlive(pid) && isAppServerProcess(pid, paths)
    ? pid
    : null;
}

export function isAppServerRunning(): boolean {
  return getAppServerPid() !== null;
}

export interface AppServerState {
  listenPort: number;
  /**
   * Gateway URL the app server proxies to — `getGatewayUrl` of the entry it
   * fronts. Undefined in state records that predate the field; callers treat
   * an unknown upstream as unverified and restart the app server so the
   * running config provably targets the requested gateway and the state is
   * stamped for future comparisons.
   */
  gatewayUrl?: string;
  /**
   * Fingerprint of the injected SPA config and its source bundle. Undefined
   * for records that predate the field; an app server without a recorded
   * fingerprint is treated as drifted and restarted so the served index
   * provably carries the requested config.
   */
  remoteWebConfigHash?: string;
  /**
   * The serve spec the spawned server child reads at boot: the upstream, the
   * dist roots, and the injected documents. Written by the starting parent;
   * the child is stateless beyond it.
   */
  serve?: {
    gatewayUrl: string;
    webDistDir: string;
    appDistDir: string;
    indexHtmlPath: string;
    appIndexHtmlPath: string;
    config: Record<string, unknown>;
  };
}

export function appServerStatePath(): string {
  return join(getAppServerPaths().dir, "state.json");
}

/** The pre-rename state path, read when the renamed one has no record yet. */
function legacyStatePath(): string {
  return join(resolveDataDir(), LEGACY_INGRESS_DIR, "state.json");
}

export function readAppServerState(): AppServerState | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(appServerStatePath(), "utf-8"));
  } catch {
    // The renamed dir has no record yet; a pre-rename install's record
    // still tells the truth about a running pre-rename server.
    if (!existsSync(appServerStatePath()) && existsSync(legacyStatePath())) {
      try {
        raw = JSON.parse(readFileSync(legacyStatePath(), "utf-8"));
      } catch {
        return null;
      }
    } else {
      return null;
    }
  }
  const state = (raw ?? {}) as Record<string, unknown>;
  const listenPort = state.listenPort;
  if (typeof listenPort !== "number") return null;
  const gatewayUrl = state.gatewayUrl;
  const remoteWebConfigHash = state.remoteWebConfigHash;
  const serve = state.serve as AppServerState["serve"] | undefined;
  return {
    listenPort,
    ...(typeof gatewayUrl === "string" ? { gatewayUrl } : {}),
    ...(typeof remoteWebConfigHash === "string" ? { remoteWebConfigHash } : {}),
    ...(serve && typeof serve === "object" ? { serve } : {}),
  };
}

function clearStoppedAppServer(pidPath: string): void {
  rmSync(appServerStatePath(), { force: true });
  rmSync(pidPath, { force: true });
  // The app server is gone; release the root lockfile's process entry with
  // it. Its built-sha stamp survives (a build-cache fact, not a process
  // fact) so restarting never pays a needless bundle rebuild.
  clearAppProcessRecord();
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
 * Stop the running app server via its pidfile and clear the recorded state.
 * Returns true if a process was stopped.
 *
 * Verifies the PID still belongs to this app server before killing to avoid
 * hitting an unrelated process if the OS has reused the PID. SIGTERM first;
 * escalate to SIGKILL if it doesn't exit within the timeout.
 */
export async function stopAppServer(): Promise<boolean> {
  const paths = getAppServerPaths();

  const pid = readPidFile(paths.pidPath);
  if (pid === null || !isPidAlive(pid) || !isAppServerProcess(pid, paths)) {
    clearStoppedAppServer(paths.pidPath);
    return false;
  }

  try {
    process.kill(pid, "SIGTERM");
    if (!(await waitForPidExit(pid, STOP_TIMEOUT_MS))) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        if (!isPidAlive(pid)) {
          clearStoppedAppServer(paths.pidPath);
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
      clearStoppedAppServer(paths.pidPath);
      return true;
    }
    return false;
  }

  clearStoppedAppServer(paths.pidPath);
  return true;
}

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

export const DENY_PATHS: ReadonlySet<string> = (() => {
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

/** Whether a TCP listener already holds `port` on the loopback. */
async function isPortInUse(port: number): Promise<boolean> {
  // The package's connect probe is the repo's one port-usage tracker —
  // true means something is listening, so the port is taken.
  return await probePort(port);
}

/**
 * The first free loopback port at or above `startPort`, scanning a short band,
 * or null when the whole band is busy.
 */
export async function findAvailableServerPort(
  startPort: number,
  attempts = 20,
): Promise<number | null> {
  for (let port = startPort; port < startPort + attempts; port++) {
    if (await isPortInUse(port)) {
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

export function appOrigins(config: Record<string, unknown>): string[] {
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
    [fileURLToPath(new URL("./bun.ts", import.meta.url)), paths.dir],
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
