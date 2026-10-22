import { z } from "zod";
import { join } from "path";
import { TUNNEL_PROVIDERS } from "@mycadet/service-contracts/ingress";
import {
  clearRootProcess,
  formatAssistantReference,
  loadAllAssistants,
  loadAllAssistantsAcrossEnvs,
  readRootProcesses,
  resolveTargetAssistant,
  type AssistantEntry,
  type TunnelProcessRecord,
} from "./assistant-config.js";
import { isCloudHome } from "./cloud-values.js";
import { cliCommand } from "./cli-name.js";

import {
  getDefaultWorkspaceDir,
  isLocalContainerEntry,
  loadRawConfig,
  parseGatewayPortFromEntryUrls,
} from "./ingress-config.js";
import {
  ensureAppServer,
  getNginxVersion,
  isIngressRunning,
  readIngressState,
  type AppServer,
} from "./nginx-ingress.js";
import { waitForDaemonReady } from "./http-client.js";
import {
  confirmStopAnswer,
  endpointHost,
  hasWebhookIntegrations,
  IngressConfigSchema,
  isNgrokEndpointOnlineError,
  loadNgrokDomain,
  maybeStartNgrokTunnel,
  ngrokHolderPid,
  ngrokOnlineEndpoint,
  NGROK_TUNNEL_META,
  NGROK_PROVIDER,
  saveNgrokDomain,
  stopNgrokHolderPid,
} from "./tunnels/ngrok.js";
import { ensureBinaryInstalled, readLineText } from "./ensure-binary.js";
import { notifyGatewayOfPublicUrl } from "./tunnels/gateway-notify.js";
import {
  selectRestartTunnelRecord,
  type TunnelProviderName,
} from "@mycadet/service-contracts/ingress";
import { CADET_PROVIDER, CADET_TUNNEL_META } from "./tunnels/cadet.js";
import {
  CLOUDFLARE_PROVIDER,
  CLOUDFLARE_TUNNEL_META,
} from "./tunnels/cloudflare.js";
import {
  recoverTailscaleIngressUrl,
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
 * and the holder can be identified (tracked record, or inspection API +
 * verified pid), ask before stopping it; an unverified process is never
 * touched. Returns whether the caller should relaunch the tunnel.
 */
export async function offerStopNgrokHolder(logText: string): Promise<boolean> {
  if (!isNgrokEndpointOnlineError(logText)) return false;
  if (!("isTTY" in process.stdin && process.stdin.isTTY)) return false;
  const endpoint = ngrokOnlineEndpoint(logText);
  const holderHost =
    (endpoint ? endpointHost(endpoint) : null) ?? loadNgrokDomain();
  if (!holderHost) return false;
  const pid = await ngrokHolderPid(holderHost);
  if (pid === null) return false;
  console.error(
    `\nngrok refused the tunnel: ${endpoint ?? holderHost} is already online.`,
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
  workspaceDir: string;
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
  workspaceDir?: string;
}

export interface TunnelProvider {
  run(opts: ProviderTunnelOptions): Promise<ProviderTunnelResult>;
  stop(opts: ProviderStopOptions): Promise<boolean>;
}

const providers: Record<TunnelProviderName, TunnelProvider> = {
  ngrok: NGROK_PROVIDER,
  cloudflare: CLOUDFLARE_PROVIDER,
  tailscale: TAILSCALE_PROVIDER,
  cadet: CADET_PROVIDER,
};
const providerNameSchema = z.enum(TUNNEL_PROVIDERS);

/**
 * A tunnelable assistant plus the gateway port and workspace the edge fronts.
 */
export interface LocalTunnelTarget {
  entry: AssistantEntry;
  gatewayPort: number;
  workspaceDir: string;
}

/**
 * Map an entry to its local tunnel target, or null when it has no locally
 * reachable gateway (e.g. cloud-hosted). Entries with `resources` carry
 * their own gateway port and instance workspace. Local container entries
 * (docker, apple-container) run locally without host resources: their gateway
 * port comes from localUrl/runtimeUrl and their ingress state lives in the
 * default workspace.
 */
export function toLocalTunnelTarget(
  entry: AssistantEntry,
): LocalTunnelTarget | null {
  if (entry.resources) {
    return {
      entry,
      gatewayPort: entry.resources.gatewayPort,
      workspaceDir: join(entry.resources.instanceDir, "workspace"),
    };
  }
  if (isLocalContainerEntry(entry)) {
    const gatewayPort = parseGatewayPortFromEntryUrls(entry);
    if (gatewayPort !== undefined) {
      return { entry, gatewayPort, workspaceDir: getDefaultWorkspaceDir() };
    }
  }
  return null;
}

export function describeUntunnelableEntry(entry: AssistantEntry): string {
  const reference = formatAssistantReference(entry);
  return isCloudHome(entry.cloud)
    ? `Assistant '${reference}' runs on Cadet Cloud and needs no tunnel.`
    : `Assistant '${reference}' has no locally managed runtime to tunnel.`;
}

/**
 * Resolve the assistant whose gateway and workspace the app server fronts.
 * Tunnels only make sense for assistants with a local gateway; when the
 * active assistant has none (e.g. it is cloud-hosted) fall back to the sole
 * local target, otherwise exit with an error naming the way to pick one.
 */
export function resolveLocalTunnelTarget(): LocalTunnelTarget {
  const entry = resolveTargetAssistant();

  const target = toLocalTunnelTarget(entry);
  if (target) {
    return target;
  }

  const localTargets = loadAllAssistants()
    .map(toLocalTunnelTarget)
    .filter((local): local is LocalTunnelTarget => local !== null);

  if (localTargets.length === 1) {
    console.log(
      `${describeUntunnelableEntry(entry)} Tunneling the local assistant '${formatAssistantReference(localTargets[0].entry)}' instead.`,
    );
    return localTargets[0];
  }

  console.error(describeUntunnelableEntry(entry));
  if (localTargets.length === 0) {
    console.error(
      `No local assistant found to tunnel. Run \`${cliCommand()} hatch\` first.`,
    );
  } else {
    console.error(
      `Multiple local assistants found; set the one to front with \`${cliCommand()} use <name>\`.`,
    );
  }
  process.exit(1);
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
  await refreshEdgeWithEstablishedUrl(opts, result.publicUrl);
  await result.waitForExit;
  return { publicUrl: result.publicUrl };
}

/**
 * Re-ensure the edge right after a tunnel establishes, so the fresh public
 * URL (saved by the provider run) lands in the served config's `cloudUrl` in
 * the same session that created it. A no-op when the saved URL is not the
 * established one — e.g. a tailscale pairing-only run, which must never
 * repoint the webhook callback base the saved URL stands for.
 */
async function refreshEdgeWithEstablishedUrl(
  opts: ProviderTunnelOptions,
  publicUrl: string,
): Promise<void> {
  let savedUrl: string | undefined;
  try {
    const config = loadRawConfig(opts.workspaceDir);
    const ingress = config.ingress as Record<string, unknown> | undefined;
    const url = ingress?.publicBaseUrl;
    if (typeof url === "string" && url.trim()) savedUrl = url.trim();
  } catch {
    return;
  }
  if (!savedUrl) return;
  if (savedUrl.replace(/\/+$/, "") !== publicUrl.replace(/\/+$/, "")) return;
  const state = isIngressRunning(opts.workspaceDir)
    ? readIngressState(opts.workspaceDir)
    : null;
  if (state?.gatewayPort === undefined) return;
  try {
    await ensureAppServer({
      assistantId: opts.assistantId,
      workspaceDir: opts.workspaceDir,
      gatewayPort: state.gatewayPort,
    });
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
export async function stopTunnelProcess(
  workspaceDir?: string,
): Promise<boolean> {
  const recorded: TunnelProcessRecord | undefined = readRootProcesses().tunnel;
  if (!recorded) return false;
  const provider = providerNameSchema.parse(
    recorded.provider ?? DEFAULT_TUNNEL_PROVIDER,
  );
  const stopped = await providers[provider].stop({
    record: recorded,
    workspaceDir,
  });
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

export {
  ADOPTED_TUNNEL_RE,
  hasWebhookIntegrationsConfigured,
} from "./tunnels/ngrok.js";
export { cadetTunnelComingSoonError } from "./tunnels/cadet.js";

/** Matches the Docker hatch path's service-readiness allowance. */
export const DOCKER_GATEWAY_READY_TIMEOUT_MS = 5 * 60_000;

/**
 * Whether the workspace ingress config wants the remote-web edge: explicitly
 * enabled with a saved public URL.
 */
function wantsWebIngress(config: Record<string, unknown>): boolean {
  const parsed = IngressConfigSchema.safeParse(config.ingress);
  return (
    parsed.success &&
    parsed.data.enabled === true &&
    (parsed.data.publicBaseUrl?.trim() ?? "") !== ""
  );
}

/**
 * Whether anything wants the nginx edge: webhook integrations or the
 * remote-web ingress config. One config read covers both checks;
 * `maybeStartNgrokTunnel` keeps its own webhook gate for its other callers.
 */
function wantsAppServer(workspaceDir: string): boolean {
  try {
    const config = loadRawConfig(workspaceDir);
    return hasWebhookIntegrations(config) || wantsWebIngress(config);
  } catch {
    return false;
  }
}

/**
 * The `cadet tunnel start` invocation that rebuilds this assistant's edge.
 * That command requires `--provider`, and a `<provider>` placeholder would be
 * shell redirection rather than something to paste, so name the provider
 * recorded here; with none recorded, point at the help that lists them.
 */
function tunnelRestartCommand(workspaceDir: string): string {
  try {
    const record = selectRestartTunnelRecord(
      loadRawConfig(workspaceDir).ingress,
    );
    if (record) {
      return `${cliCommand()} tunnel start --provider ${record.provider}`;
    }
  } catch {
    // An unreadable config names no provider; the help pointer still holds.
  }
  return `${cliCommand()} tunnel --help`;
}

/**
 * Listen port of an SPA edge still serving in front of `gatewayPort`, or null
 * when nothing verifiably fronts that gateway (an unrecorded upstream port is
 * unverified, see `IngressState`).
 */
function survivingAppServerPort(
  workspaceDir: string,
  gatewayPort: number,
): number | null {
  try {
    const recorded = isIngressRunning(workspaceDir)
      ? readIngressState(workspaceDir)
      : null;
    return recorded?.gatewayPort === gatewayPort ? recorded.listenPort : null;
  } catch {
    return null;
  }
}

/**
 * Bring the nginx edge back up after a wake or local upgrade. The edge is
 * wanted when webhook integrations are configured or the workspace ingress
 * config is enabled with a saved public URL. `ensureAppServer` owns the reuse
 * decision, so a running edge is adopted only while its mode, gateway port,
 * and injected SPA config fingerprint all match what this restore asks for; an
 * edge that drifted in any of those respects (a renamed assistant, a changed
 * hub URL, an older edge template) is restarted rather than adopted, which is
 * what keeps a wake from serving a config the current CLI would never
 * generate.
 *
 * Several of those failures leave the old edge serving (the web-dist preflight
 * bails before it is stopped; a drifted edge whose stop fails is reported as
 * stale), and tunneling the gateway directly would take the edge's
 * sensitive-route denylist out from in front of the tunnel. So a failure warns
 * and reports a surviving SPA edge as the target instead.
 *
 * Returns the loopback port a tunnel should front, or null when no edge is
 * wanted and when none survives a failed rebuild.
 */
export async function restoreAppServer(
  assistantId: string,
  gatewayPort: number,
  workspaceDir: string,
  /** Whether the caller tunnels the gateway port directly when the edge fails,
   *  which is what keeps webhook delivery alive without an edge. */
  gatewayFallback = true,
): Promise<number | null> {
  // The gateway clears a tunnel-managed ingress URL whenever it starts, and
  // the local gateway has just been started. A tailnet serve outlives that
  // (tailscaled keeps the mapping), so put its URL back before deciding
  // whether anything wants the edge. Non-fatal: a failed probe just leaves
  // the config as the gateway left it.
  try {
    const recovered = await recoverTailscaleIngressUrl({
      workspaceDir,
      assistantId,
    });
    if (recovered) {
      console.log(
        `   Restored the tailnet ingress URL ${recovered} (the gateway start had cleared it).`,
      );
    }
  } catch (err) {
    console.warn(
      `   Could not check the saved tailnet serve: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!wantsAppServer(workspaceDir)) {
    return null;
  }
  let edge: AppServer;
  try {
    edge = await ensureAppServer({
      assistantId,
      workspaceDir,
      gatewayPort,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const survivingPort = survivingAppServerPort(workspaceDir, gatewayPort);
    const impact =
      survivingPort !== null
        ? `The app server already running on 127.0.0.1:${survivingPort} stays in front of the gateway, serving an outdated config.`
        : gatewayFallback
          ? "Webhooks still work, but the web app is not being served."
          : "The web app and webhook delivery are unavailable until it is rebuilt.";
    console.warn(
      `   Could not restore the app server: ${detail} ${impact} Run \`${tunnelRestartCommand(workspaceDir)}\` to rebuild the app server.`,
    );
    return survivingPort;
  }
  console.log(
    `   App server ${edge.started ? "started" : "already running"} on 127.0.0.1:${edge.port} (app shell + remote web + webhooks).`,
  );
  return edge.port;
}

/**
 * Whether a container entry may restore the shared default-workspace edge.
 *
 * Waking one container must not repoint another's public endpoint at its own
 * gateway, and `ensureAppServer` cannot make that call: it restarts an edge
 * whose recorded gateway port drifts, which is the hijack itself. A running
 * edge records its `gatewayPort` — an edge serving a different recorded
 * gateway port disqualifies the wake; with no running edge (or one already
 * fronting this assistant), the restore may proceed.
 */
function ownsSharedIngress(gatewayPort: number, workspaceDir: string): boolean {
  return !(
    isIngressRunning(workspaceDir) &&
    readIngressState(workspaceDir)?.gatewayPort !== gatewayPort
  );
}

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
  entry: AssistantEntry,
  gatewayReadyTimeoutMs = 0,
): Promise<void> {
  if (!isLocalContainerEntry(entry)) {
    return;
  }
  const gatewayPort = parseGatewayPortFromEntryUrls(entry);
  if (gatewayPort === undefined) {
    return;
  }
  const workspaceDir = getDefaultWorkspaceDir();
  if (!ownsSharedIngress(gatewayPort, workspaceDir)) {
    return;
  }
  // Gate before waiting: a container that was never tunneled wants no edge, and
  // must not pay the gateway-readiness wait to find that out.
  if (!wantsAppServer(workspaceDir)) {
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
      `   Gateway on 127.0.0.1:${gatewayPort} did not come up, so the app server was not restored. Run \`${tunnelRestartCommand(workspaceDir)}\` once it is running.`,
    );
    return;
  }
  await restoreAppServerAndAutoTunnel(
    entry.assistantId,
    gatewayPort,
    workspaceDir,
  );
}

/**
 * Restore the nginx edge, then start the default provider's tunnel at it
 * (the gateway port when the edge is down, keeping webhook delivery alive).
 * The spawned agent records itself in the root lockfile under `tunnel`;
 * adopting an already-running one clears any stale entry.
 */
export async function restoreAppServerAndAutoTunnel(
  assistantId: string,
  gatewayPort: number,
  workspaceDir: string,
): Promise<void> {
  const edgePort = await restoreAppServer(
    assistantId,
    gatewayPort,
    workspaceDir,
  );
  await maybeStartNgrokTunnel(
    edgePort ?? gatewayPort,
    workspaceDir,
    assistantId,
  );
}
