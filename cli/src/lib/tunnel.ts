import { z } from "zod";
import { TUNNEL_PROVIDERS } from "@mycadet/service-contracts/ingress";
import {
  clearRootProcess,
  loadAllAssistants,
  readRootProcesses,
  resolveTargetAssistant,
  type LockfileAssistant,
  type TunnelProcessRecord,
} from "./assistant-config.js";
import { cliCommand } from "./cli-name.js";
import {
  GATEWAY_PORT,
  getGatewayUrl,
  getLoopbackGatewayPort,
  isLocalRuntimeEntry,
} from "@mycadet/local-mode/contract";

import { isLocalContainerEntry } from "./ingress-config.js";
import {
  ensureAppServer,
  getNginxVersion,
  isIngressRunning,
  readIngressState,
  isPidAlive,
  type AppServer,
} from "./servers/nginx.js";
import { waitForDaemonReady } from "./http-client.js";
import {
  confirmStopAnswer,
  isNgrokEndpointOnlineError,
  ngrokHolderPid,
  ngrokOnlineEndpoint,
  NGROK_TUNNEL_META,
  NGROK_PROVIDER,
  saveNgrokDomain,
  stopNgrokHolderPid,
} from "./tunnels/ngrok.js";
import { ensureBinaryInstalled, readLineText } from "./ensure-binary.js";
import { notifyGatewayOfPublicUrl } from "./tunnels/gateway-notify.js";
import { type TunnelProviderName } from "@mycadet/service-contracts/ingress";
import { CADET_PROVIDER, CADET_TUNNEL_META } from "./tunnels/cadet.js";
import {
  CLOUDFLARE_PROVIDER,
  CLOUDFLARE_TUNNEL_META,
} from "./tunnels/cloudflare.js";
import {
  TAILSCALE_PROVIDER,
  TAILSCALE_TUNNEL_META,
} from "./tunnels/tailscale.js";

/**
 * The provider the automatic tunnel paths start when no provider is named.
 * ngrok today; the north star has the managed `cadet` tunnel as the eventual
 * default, at which point only this constant flips.
 */
export const DEFAULT_TUNNEL_PROVIDER: TunnelProviderName = "ngrok";

/**
 * Confirm-first heal for a held ngrok domain, run by the FOREGROUND `cadet
 * tunnel` command: the detached tunnel process has no TTY, so its #402/#406
 * prompt can never fire — a 334 there surfaces here instead, in the
 * terminal that ran the command. When the startup log shows the collision
 * and the lockfile records a live tracked agent, ask before stopping it;
 * externally started agents are never touched. Returns whether the caller
 * should relaunch the tunnel.
 */
export async function offerStopNgrokHolder(logText: string): Promise<boolean> {
  if (!isNgrokEndpointOnlineError(logText)) return false;
  if (!("isTTY" in process.stdin && process.stdin.isTTY)) return false;
  const endpoint = ngrokOnlineEndpoint(logText);
  const pid = await ngrokHolderPid();
  if (pid === null) return false;
  console.error(
    `\nngrok refused the tunnel: ${endpoint ?? "the ngrok endpoint"} is already online.`,
  );
  console.error(
    `An ngrok agent from an earlier run (pid ${pid}) is holding your free ngrok domain.`,
  );
  const answer = await readLineText(
    "Stop the other ngrok tunnel and start a new one pointing at this installation? [Y/n] ",
  );
  if (!confirmStopAnswer(answer)) {
    console.error(
      "Keeping the other ngrok agent. Stop it yourself (its terminal, or `pkill ngrok`) and re-run this command.",
    );
    return false;
  }
  if (!(await stopNgrokHolderPid(pid))) {
    console.error(
      `Could not stop the old ngrok agent (pid ${pid}). Stop it yourself and re-run this command.`,
    );
    return false;
  }
  console.log("Stopped the old ngrok agent. Retrying the tunnel...");
  return true;
}

/** Per-provider copy `cadet tunnel`'s help renders. */
export interface ProviderMeta {
  /** How far the tunnel URL reaches. */
  reach: string;
  /** Install instruction line, rendered under the provider entry. */
  install: string;
  /** Extra behavior notes, rendered under the install line. */
  notes?: string[];
  /** Example reserved-domain value, for providers that support `--domain`. */
  domainExample?: string;
  /** Whether `--domain`/`--clear-domain` can bind a reserved domain. */
  supportsReservedDomain: boolean;
  /**
   * Listed but not yet implemented: the command refuses it before starting
   * any infrastructure, so `--provider <name>` fails fast with the
   * coming-soon copy instead of building an edge nothing will use.
   */
  comingSoon?: boolean;
}

/**
 * The registry: each provider's copy lives in its own `tunnels/<provider>.ts`
 * module and is assembled here, so `cadet tunnel`'s help, `--provider`
 * validation, and dispatch all read one shape.
 */
export const PROVIDER_META: Record<TunnelProviderName, ProviderMeta> = {
  cadet: CADET_TUNNEL_META,
  ngrok: NGROK_TUNNEL_META,
  cloudflare: CLOUDFLARE_TUNNEL_META,
  tailscale: TAILSCALE_TUNNEL_META,
};

/**
 * Registry check that tolerates any provider spelling: only providers whose
 * meta claims reserved-domain support accept `--domain`/`--clear-domain`.
 */
export function providerSupportsReservedDomain(provider: string): boolean {
  for (const [name, meta] of Object.entries(PROVIDER_META)) {
    if (name === provider) return meta.supportsReservedDomain;
  }
  return false;
}

/** Options every provider tunnel accepts; `runProviderTunnel` maps them. */
export interface ProviderTunnelOptions {
  port: number;
  assistantId?: string;
  /** Reserved domain to bind (providers that support one only). */
  domain?: string;
  /** Tailnet-only runs keep the webhook callback base as it is. */
  preserveIngressUrl?: boolean;
}

/**
 * What every tunnel provider's run hands back: the public URL it established
 * or adopted, and the promise that settles when the run ends. Conformance is
 * the point — the tunnel level can notify the gateway the same way no matter
 * which provider ran.
 */
export interface ProviderTunnelResult {
  publicUrl: string;
  waitForExit: Promise<void>;
}

export interface ProviderStopOptions {
  record: TunnelProcessRecord;
  assistantId?: string;
}

export interface TunnelProvider {
  run(opts: ProviderTunnelOptions): Promise<ProviderTunnelResult>;
  stop(opts: ProviderStopOptions): Promise<boolean>;
}

// The entries read the provider modules' bindings at call time (the #489
// getter lesson): cli/src/__tests__/tunnel.test.ts mock.module's the tunnels
// modules AFTER this module evaluates, and a directly-captured object would
// bypass the re-mock — the getter re-reads the live binding per dispatch.
const providers: Record<TunnelProviderName, TunnelProvider> = {
  get ngrok() {
    return NGROK_PROVIDER;
  },
  get cloudflare() {
    return CLOUDFLARE_PROVIDER;
  },
  get tailscale() {
    return TAILSCALE_PROVIDER;
  },
  get cadet() {
    return CADET_PROVIDER;
  },
};
const providerNameSchema = z.enum(TUNNEL_PROVIDERS);

/**
 * A tunnelable assistant plus the gateway port and workspace the edge fronts.
 */
export interface LocalTunnelTarget {
  entry: LockfileAssistant;
  gatewayPort: number;
}

/**
 * Map an entry to its local tunnel target, or null when it has no locally
 * reachable gateway (e.g. cloud-hosted). Entries with `resources` carry
 * their own gateway port and instance workspace. Local container entries
 * (docker, apple-container) run locally without host resources: their
 * gateway port comes from their recorded runtime url and their ingress
 * state lives in the default workspace.
 */
export function toLocalTunnelTarget(
  entry: LockfileAssistant,
): LocalTunnelTarget | null {
  if (isLocalRuntimeEntry(entry) && entry.resources?.instanceDir) {
    return { entry, gatewayPort: entry.resources.gatewayPort };
  }
  if (isLocalContainerEntry(entry)) {
    const gatewayPort = getLoopbackGatewayPort(entry);
    if (gatewayPort !== undefined) {
      return { entry, gatewayPort };
    }
  }
  return null;
}

/**
 * Make sure nginx is installed for the app server, offering to install it
 * when missing. Exits the process when nginx cannot be found or installed —
 * every edge-starting command (`cadet tunnel start`, `cadet app start`)
 * shares the same requirement.
 */
export async function ensureNginxForEdge(): Promise<string> {
  const nginxVersion = await ensureBinaryInstalled({
    binary: "nginx",
    purpose: "the app server",
    packages: {
      brew: ["brew", "install", "nginx"],
      "apt-get": ["sudo", "apt-get", "install", "-y", "nginx"],
      dnf: ["sudo", "dnf", "install", "-y", "nginx"],
      pacman: ["sudo", "pacman", "-S", "--noconfirm", "nginx"],
      zypper: ["sudo", "zypper", "install", "-y", "nginx"],
      choco: ["choco", "install", "-y", "nginx"],
    },
    manualHint:
      "See https://nginx.org/en/docs/install.html for how to install, or point NGINX_BIN at an existing binary.",
    probe: getNginxVersion,
  });
  if (!nginxVersion) {
    console.error("Error: nginx is required to run the app server.");
    process.exit(1);
  }
  return nginxVersion;
}

/**
 * Tell EVERY locally-reachable assistant's gateway the tunnel's public URL:
 * the tunnel fronts one edge, but its ingress domain is app-global info —
 * any assistant the app serves can hand the URL to a session. Best-effort
 * per assistant; one dead gateway never fails the others.
 */
export async function notifyAllLocalGatewaysOfPublicUrl(
  publicUrl: string,
): Promise<void> {
  const targets = loadAllAssistants()
    .map(toLocalTunnelTarget)
    .filter((target): target is LocalTunnelTarget => target !== null);
  await Promise.all(
    targets.map((target) =>
      notifyGatewayOfPublicUrl(publicUrl, target.entry.assistantId),
    ),
  );
}

/**
 * Run a tunnel provider by name — the dispatch `cadet tunnel start` uses, so
 * the command layer never names a provider implementation directly. Notifies
 * every local gateway of the resulting public URL identically for each
 * provider, then holds until the run ends.
 */
export async function runProviderTunnel(
  provider: TunnelProviderName,
  opts: ProviderTunnelOptions,
): Promise<{ publicUrl: string }> {
  const result = await runProvider(provider, opts);
  await notifyAllLocalGatewaysOfPublicUrl(result.publicUrl);
  await refreshEdgeWithEstablishedUrl();
  await result.waitForExit;
  return { publicUrl: result.publicUrl };
}

/**
 * Re-ensure the edge right after a tunnel establishes, so the fresh public
 * URL (saved by the provider run) lands in the served config's `cloudUrl` in
 * the same session that created it. A no-op when the run published no public
 * URL — a tailscale pairing-only run, which must never repoint the webhook
 * callback base the saved URL stands for.
 *
 * The saved URL comes from the root lockfile's `tunnel` record — the run
 * stamps it with the URL it published — never from a workspace config: the
 * tunnel layer's own state lives in the lockfile.
 */
async function refreshEdgeWithEstablishedUrl(): Promise<void> {
  const savedUrl = readRootProcesses().tunnel?.publicUrl;
  if (!savedUrl) return;
  // Only re-ensure an edge that already fronts this assistant's gateway: the
  // app server resolves the assistant it fronts itself (the lockfile's active
  // entry), so an edge pointing elsewhere is left alone rather than
  // repointed from a refresh.
  const state = isIngressRunning() ? readIngressState() : null;
  if (state?.gatewayUrl === undefined) return;
  if (state.gatewayUrl !== getGatewayUrl(resolveTargetAssistant())) return;
  try {
    await ensureAppServer();
  } catch {
    // The running edge stays in front of the tunnel; the fresh config lands
    // via the next invocation's fingerprint drift instead.
  }
}

/** Map the provider name onto its run — no gateway notification here. */
function runProvider(
  provider: TunnelProviderName,
  opts: ProviderTunnelOptions,
): Promise<ProviderTunnelResult> {
  return providers[provider].run(opts);
}

/** Drop the saved reserved-domain record (providers that keep one). */
export function clearReservedDomain(): void {
  saveNgrokDomain(null);
}

/**
 * Stop a tunnel agent this CLI started, per the root lockfile's `tunnel`
 * entry. The pid is verified against the provider's process identity before
 * signaling — a stale entry after PID reuse must not kill an unrelated
 * process.
 */
export async function stopTunnelProcess(): Promise<boolean> {
  const recorded: TunnelProcessRecord | undefined = readRootProcesses().tunnel;
  if (!recorded) return false;
  const provider = providerNameSchema.parse(
    recorded.provider ?? DEFAULT_TUNNEL_PROVIDER,
  );
  const stopped = await providers[provider].stop({ record: recorded });
  clearRootProcess("tunnel", recorded.pid);
  return stopped;
}

/**
 * The `cadet tunnel --detach` copy for a run that adopted an already-running
 * agent: killing the supervisor does not stop a tunnel it did not spawn.
 */
export function adoptedTunnelStopNotice(pid: number | undefined): string {
  return (
    `That ngrok agent was already running outside this command, so \`kill ${pid}\` only ` +
    "stops this supervisor, not the ngrok tunnel or its saved ingress URL. Stop the ngrok agent " +
    "directly to end the tunnel."
  );
}

/**
 * Pull the single most meaningful failure line out of a tunnel log so the
 * `cadet tunnel` wrapper can name why the child died instead of only pointing
 * at the log file. Priority: nginx emerg/bind failures, ngrok error codes,
 * auth/usage failures, then any generic error/fatal/failed line — the LAST
 * match wins (the freshest), capped to keep the console line readable. Falls
 * back to the last non-empty log line, or null for an empty log.
 */
export function summarizeStartupFailure(logText: string): string | null {
  const lines = logText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return null;
  }
  const patterns: RegExp[] = [
    /\[emerg\]/,
    /bind\(\).*failed/i,
    /address already in use/i,
    /ERR_NGROK_\d+/,
    /authtoken|authentication failed|usage limit|unauthorized/i,
    /\berror\b|\bfatal\b|\bfailed\b/i,
  ];
  const cap = (line: string): string =>
    line.length > 200 ? `${line.slice(0, 200)}…` : line;
  for (const pattern of patterns) {
    const matches = lines.filter((line) => pattern.test(line));
    const last = matches.at(-1);
    if (last !== undefined) {
      return cap(last);
    }
  }
  const lastLine = lines.at(-1);
  return lastLine === undefined ? null : cap(lastLine);
}

/** Matches the Docker hatch path's service-readiness allowance. */
export const DOCKER_GATEWAY_READY_TIMEOUT_MS = 5 * 60_000;

/**
 * Whether the root lockfile records an app server. The restore flow stamps
 * the `app` entry when it establishes the edge, and the entry outlives the
 * edge's own stop (only the built-sha stamp rides between runs), so it is
 * the CLI's own record that this assistant wants its app server back —
 * read from the lockfile alone, with no workspace access.
 */
function wantsAppServer(): boolean {
  return readRootProcesses().app !== undefined;
}

/**
 * The `cadet tunnel start` invocation that rebuilds this assistant's edge.
 * That command requires `--provider`, and a `<provider>` placeholder would be
 * shell redirection rather than something to paste, so name the provider the
 * root lockfile's `tunnel` record carries — the tunnel layer's own state of
 * record, stamped by every run and cleared only by a stop; with none
 * recorded, point at the help that lists them.
 */
function tunnelRestartCommand(): string {
  try {
    const record = readRootProcesses().tunnel;
    if (record?.provider) {
      return `${cliCommand()} tunnel start --provider ${record.provider}`;
    }
  } catch {
    // An unreadable lockfile names no provider; the help pointer still holds.
  }
  return `${cliCommand()} tunnel --help`;
}

/**
 * Listen port of an SPA edge still serving in front of `gatewayUrl`, or null
 * when nothing verifiably fronts that gateway (an unrecorded upstream is
 * unverified, see `IngressState`).
 */
function survivingAppServerPort(): number | null {
  try {
    const app = readRootProcesses().app;
    return app?.pid !== undefined && isPidAlive(app.pid) ? app.port : null;
  } catch {
    return null;
  }
}

/**
 * Bring the nginx edge back up after a wake or local upgrade. The edge is
 * wanted when the root lockfile records one — the `app` entry the restore
 * flow stamps when it establishes the edge. `ensureAppServer` owns the reuse
 * decision (and resolves the assistant it fronts from the lockfile), so a
 * running edge is adopted only while its gateway upstream and injected SPA
 * config fingerprint match what this restore asks for; an edge that drifted
 * in either respect (a renamed assistant, a changed hub URL) is restarted
 * rather than adopted, which is what keeps a wake from serving a config the
 * current CLI would never generate.
 *
 * Several of those failures leave the old edge serving (the web-dist preflight
 * bails before it is stopped; a drifted edge whose stop fails is reported as
 * stale), and tunneling the gateway directly would take the edge's
 * sensitive-route denylist out from in front of the tunnel. So a failure warns
 * and reports a surviving SPA edge as the target instead.
 *
 * Returns the loopback port a tunnel should front — always defined: the
 * app server's own port when it runs, else the gateway's (webhook delivery
 * survives without an edge; the web app does not).
 */
export async function restoreAppServer(
  entry: LockfileAssistant,
): Promise<number> {
  if (!wantsAppServer()) {
    return getLoopbackGatewayPort(entry) ?? GATEWAY_PORT;
  }
  let appServer: AppServer;
  try {
    appServer = await ensureAppServer();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const survivingPort = survivingAppServerPort();
    const impact =
      survivingPort !== null
        ? `The app server already running on 127.0.0.1:${survivingPort} stays in front of the gateway, serving an outdated config.`
        : "Webhooks still work, but the web app is not being served.";
    console.warn(
      `   Could not restore the app server: ${detail} ${impact} Run \`${tunnelRestartCommand()}\` to rebuild the app server.`,
    );
    return survivingPort ?? getLoopbackGatewayPort(entry) ?? GATEWAY_PORT;
  }
  console.log(
    `   App server ${appServer.started ? "started" : "already running"} on 127.0.0.1:${appServer.port}.`,
  );
  return appServer.port;
}

/**
/**
 * Wake counterpart to `stopContainerAppServer`: bring the shared
 * default-workspace edge back for a container assistant, so a tunnel that
 * survived across sleep (a tailnet serve, a reserved ngrok domain) reaches the
 * gateway again without a manual `cadet tunnel`.
 *
 * The auto-tunnel runs here too, matching the local wake path: the spawned
 * agent records itself in the root lockfile under `tunnel`, so `cadet ps` and
 * the stop paths can see it instead of it leaking past the next sleep.
 */
export async function restoreContainerAppServer(
  entry: LockfileAssistant,
  gatewayReadyTimeoutMs = 0,
): Promise<void> {
  if (!isLocalContainerEntry(entry)) {
    return;
  }
  const gatewayPort = getLoopbackGatewayPort(entry);
  if (gatewayPort === undefined) {
    return;
  }
  // Gate before waiting: a container that never established an app server
  // wants no edge, and must not pay the gateway-readiness wait to find that
  // out.
  if (!wantsAppServer()) {
    return;
  }
  // `wakeContainers` returns once `docker start` is issued, so on a cold or
  // migration-heavy start the gateway is not listening yet. The edge only waits
  // `INGRESS_READY_TIMEOUT_MS` for /healthz before rolling itself back, so
  // without this the restore would fail on exactly the wakes that need it.
  if (
    gatewayReadyTimeoutMs > 0 &&
    !(await waitForDaemonReady(gatewayPort, gatewayReadyTimeoutMs))
  ) {
    console.warn(
      `   Gateway on 127.0.0.1:${gatewayPort} did not come up, so the app server was not restored. Run \`${tunnelRestartCommand()}\` once it is running.`,
    );
    return;
  }
  await restoreAppServerAndAutoTunnel(entry);
}

/**
 * The startup/recovery sequence, in dependency order — the tunnel points at
 * the app server, never the other way around:
 *
 * 1. ensure the app server is started,
 * 2. ensure the tunnel is started at it (the app server's port is what the
 *    tunnel takes),
 * 3. save the tunnel's ingress url to each assistant.
 */
export async function restoreAppServerAndAutoTunnel(
  entry: LockfileAssistant,
): Promise<void> {
  // 1. Ensure the app server is started.
  const appServerPort = await restoreAppServer(entry);
  // 2. Ensure the tunnel is started at it: lockfile.json records which
  //    tunnel we expect connected to the app server, so only that provider's
  //    own start piece runs — pointed at the app server's port.
  const publicUrl = await ensureTunnel(appServerPort, entry.assistantId);
  // 3. Save the ingress url from the tunnel to each assistant.
  if (publicUrl) {
    await notifyAllLocalGatewaysOfPublicUrl(publicUrl);
    await refreshEdgeWithEstablishedUrl();
  }
}

/**
 * Ensure the tunnel the lockfile expects is started at the app server.
 *
 * The root lockfile's `tunnel` record is the expectation: every provider run
 * stamps it (the spawned ngrok agent, the tailscale supervisor, the
 * cloudflared child) and only a stop clears it, so it outlives the gateway
 * starts that wipe the saved ingress URL and the reboots that outlive every
 * process. The dispatch sends the ensure to the recorded provider's own
 * start piece; a stopped tunnel cleared its root record, so nothing
 * resurrects it. Returns the established URL, or null when nothing was
 * started.
 */
async function ensureTunnel(
  targetPort: number,
  assistantId?: string,
): Promise<string | null> {
  const expected = readRootProcesses().tunnel;
  if (!expected?.provider) {
    return null;
  }
  // The record's `publicUrl` marks a run that published the ingress base URL
  // the app server fronts. A pairing-only tailscale run deliberately stamps
  // none — re-running its save would repoint the webhook callback base that
  // run did not repoint — so the restore only re-establishes published runs.
  if (!expected.publicUrl) {
    return null;
  }
  try {
    const result = await providers[expected.provider]?.run({
      port: targetPort,
      assistantId,
    });
    if (!result) return null;
    // The run owns nothing in this process — the agent is detached — but an
    // unhandled rejection from a settling exit promise must not crash the
    // host (wake/upgrade) either.
    result.waitForExit.catch(() => {});
    return result.publicUrl;
  } catch (err) {
    console.warn(
      `   Could not ensure the ${expected.provider} tunnel: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
