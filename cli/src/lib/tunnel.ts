import { z } from "zod";
import { TUNNEL_PROVIDERS } from "@mycadet/service-contracts/ingress";
import {
  clearRootProcess,
  loadAllAssistants,
  loadAllAssistantsAcrossEnvs,
  readRootProcesses,
  type AssistantEntry,
  type RootProcessRecord,
} from "./assistant-config.js";

import {
  getDefaultWorkspaceDir,
  isLocalContainerEntry,
  loadRawConfig,
  parseGatewayPortFromEntryUrls,
} from "./ingress-config.js";
import {
  ensureTunnelEdge,
  formatEdgeMode,
  isIngressRunning,
  readIngressState,
  type TunnelEdge,
} from "./nginx-ingress.js";
import { waitForDaemonReady } from "./http-client.js";
import {
  hasWebhookIntegrations,
  IngressConfigSchema,
  maybeStartNgrokTunnel,
  NGROK_TUNNEL_META,
  NGROK_PROVIDER,
  saveNgrokDomain,
} from "./tunnels/ngrok.js";
import { shellArg } from "./shell-arg.js";
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
  TAILSCALE_PROVIDER,
  TAILSCALE_TUNNEL_META,
} from "./tunnels/tailscale.js";

/**
 * The provider the automatic tunnel paths start when no provider is named.
 * ngrok today; the north star has the managed `cadet` tunnel as the eventual
 * default, at which point only this constant flips.
 */
export const DEFAULT_TUNNEL_PROVIDER: TunnelProviderName = "ngrok";

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
  record: RootProcessRecord;
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
 * Run a tunnel provider by name — the dispatch `cadet tunnel` uses, so the
 * command layer never names a provider implementation directly. Notifies the
 * gateway of the resulting public URL identically for every provider, then
 * holds until the run ends.
 */
export async function runProviderTunnel(
  provider: TunnelProviderName,
  opts: ProviderTunnelOptions,
): Promise<{ publicUrl: string }> {
  const result = await runProvider(provider, opts);
  await notifyGatewayOfPublicUrl(result.publicUrl, opts.assistantId);
  await result.waitForExit;
  return { publicUrl: result.publicUrl };
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
  assistantId?: string,
  workspaceDir?: string,
): Promise<boolean> {
  const recorded: RootProcessRecord | undefined = readRootProcesses().tunnel;
  if (!recorded) return false;
  if (
    assistantId &&
    recorded.assistantId &&
    recorded.assistantId !== assistantId
  ) {
    throw new Error(
      `The recorded tunnel belongs to '${recorded.assistantId}', not '${assistantId}'.`,
    );
  }
  const provider = providerNameSchema.parse(
    recorded.provider ?? DEFAULT_TUNNEL_PROVIDER,
  );
  const stopped = await providers[provider].stop({
    record: recorded,
    assistantId,
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
function wantsTunnelEdge(workspaceDir: string): boolean {
  try {
    const config = loadRawConfig(workspaceDir);
    return hasWebhookIntegrations(config) || wantsWebIngress(config);
  } catch {
    return false;
  }
}

/**
 * The `cadet tunnel` invocation that rebuilds this assistant's edge. That
 * command requires `--provider`, and a `<provider>` placeholder would be shell
 * redirection rather than something to paste, so name the provider recorded
 * here; with none recorded, point at the help that lists them.
 *
 * The assistant is named too: an unqualified run targets the active assistant,
 * which on a computer running several is not the one being restored.
 */
function tunnelRestartCommand(
  workspaceDir: string,
  assistantId: string,
): string {
  try {
    const record = selectRestartTunnelRecord(
      loadRawConfig(workspaceDir).ingress,
    );
    if (record) {
      return `cadet tunnel ${shellArg(assistantId)} --provider ${record.provider}`;
    }
  } catch {
    // An unreadable config names no provider; the help pointer still holds.
  }
  return "cadet tunnel --help";
}

/**
 * Listen port of an SPA edge still serving in front of `gatewayPort`, or null
 * when nothing verifiably fronts that gateway (an unrecorded upstream port is
 * unverified, see `IngressState`).
 */
function survivingSpaEdgePort(
  workspaceDir: string,
  gatewayPort: number,
): number | null {
  try {
    const recorded = isIngressRunning(workspaceDir)
      ? readIngressState(workspaceDir)
      : null;
    return recorded?.includeWebApp && recorded.gatewayPort === gatewayPort
      ? recorded.listenPort
      : null;
  } catch {
    return null;
  }
}

/**
 * Bring the nginx edge back up after a wake or local upgrade. The edge is
 * wanted when webhook integrations are configured or the workspace ingress
 * config is enabled with a saved public URL. `ensureTunnelEdge` owns the reuse
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
export async function restoreTunnelEdge(
  assistantId: string,
  gatewayPort: number,
  workspaceDir: string,
  /** Whether the caller tunnels the gateway port directly when the edge fails,
   *  which is what keeps webhook delivery alive without an edge. */
  gatewayFallback = true,
): Promise<number | null> {
  if (!wantsTunnelEdge(workspaceDir)) {
    return null;
  }
  let edge: TunnelEdge;
  try {
    edge = await ensureTunnelEdge({
      assistantId,
      workspaceDir,
      gatewayPort,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const survivingPort = survivingSpaEdgePort(workspaceDir, gatewayPort);
    const impact =
      survivingPort !== null
        ? `The edge already running on 127.0.0.1:${survivingPort} stays in front of the gateway, serving an outdated config.`
        : gatewayFallback
          ? "Webhooks still work, but the web app is not being served."
          : "The web app and webhook delivery are unavailable until it is rebuilt.";
    console.warn(
      `   Could not restore the tunnel edge: ${detail} ${impact} Run \`${tunnelRestartCommand(workspaceDir, assistantId)}\` to rebuild the edge.`,
    );
    return survivingPort;
  }
  console.log(
    `   Tunnel edge ${edge.started ? "started" : "already running"} on 127.0.0.1:${edge.port} (${formatEdgeMode(
      edge.includesWebApp,
    )}).`,
  );
  return edge.port;
}

/**
 * Whether a container entry may restore the shared default-workspace edge.
 *
 * Waking one container must not repoint another's public endpoint at its own
 * gateway, and `ensureTunnelEdge` cannot make that call: it restarts an edge
 * whose recorded gateway port drifts, which is the hijack itself. Two records
 * establish ownership, and both have to hold because neither survives every
 * teardown: a running edge records its `gatewayPort`, while the saved
 * `ingress.publicBaseUrl` outlives the edge and is mirrored onto its owner's
 * entry as `ingressUrl`. That mirror is optional, so only a rival entry
 * actually claiming the URL disproves ownership; the default workspace is one
 * path shared by every environment, so rivals are looked for across all of
 * them.
 */
function ownsSharedIngress(
  entry: AssistantEntry,
  gatewayPort: number,
  workspaceDir: string,
): boolean {
  if (
    isIngressRunning(workspaceDir) &&
    readIngressState(workspaceDir)?.gatewayPort !== gatewayPort
  ) {
    return false;
  }
  let publicBaseUrl: string | undefined;
  try {
    const parsed = IngressConfigSchema.safeParse(
      loadRawConfig(workspaceDir).ingress,
    );
    publicBaseUrl = parsed.success ? parsed.data.publicBaseUrl : undefined;
  } catch {
    return true;
  }
  if (!publicBaseUrl || !publicBaseUrl.trim()) {
    return true;
  }
  if (entry.ingressUrl === publicBaseUrl) {
    return true;
  }
  // The mirror is optional and predates this check, so its absence is not proof
  // of non-ownership: a workspace tunneled before mirroring, or through a
  // caller that omits `assistantId`, has a saved URL that no entry claims.
  // Only another container actually claiming this URL disproves ownership.
  return ![...loadAllAssistantsAcrossEnvs(), ...loadAllAssistants()].some(
    (other) =>
      other.assistantId !== entry.assistantId &&
      isLocalContainerEntry(other) &&
      other.ingressUrl === publicBaseUrl,
  );
}

/**
 * Wake counterpart to `stopContainerTunnelEdge`: bring the shared
 * default-workspace edge back for a container assistant, so a tunnel that
 * survived across sleep (a tailnet serve, a reserved ngrok domain) reaches the
 * gateway again without a manual `cadet tunnel`.
 *
 * The auto-tunnel runs here too, matching the local wake path: the spawned
 * agent records itself in the root lockfile under `tunnel`, so `cadet ps` and
 * the stop paths can see it instead of it leaking past the next sleep.
 */
export async function restoreContainerTunnelEdge(
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
  if (!ownsSharedIngress(entry, gatewayPort, workspaceDir)) {
    return;
  }
  // Gate before waiting: a container that was never tunneled wants no edge, and
  // must not pay the gateway-readiness wait to find that out.
  if (!wantsTunnelEdge(workspaceDir)) {
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
      `   Gateway on 127.0.0.1:${gatewayPort} did not come up, so the tunnel edge was not restored. Run \`${tunnelRestartCommand(workspaceDir, entry.assistantId)}\` once it is running.`,
    );
    return;
  }
  await restoreTunnelEdgeAndAutoTunnel(
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
export async function restoreTunnelEdgeAndAutoTunnel(
  assistantId: string,
  gatewayPort: number,
  workspaceDir: string,
): Promise<void> {
  const edgePort = await restoreTunnelEdge(
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
