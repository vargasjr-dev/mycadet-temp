import { z } from "zod";
import { TUNNEL_PROVIDERS } from "@mycadet/service-contracts/ingress";
import { loadAllAssistants } from "@mycadet/local-mode";
import { clearRootProcess, readRootProcesses } from "./assistant-config.js";
import { type TunnelProcessRecord } from "@mycadet/local-mode/contract";
import { isLocalEntry } from "@mycadet/local-mode/contract";
import {
  NGROK_TUNNEL_META,
  NGROK_PROVIDER,
  saveNgrokDomain,
} from "./tunnels/ngrok.js";
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
  /** Reserved domain to bind (providers that support one only). */
  domain?: string;
  /** Tailnet-only runs keep the webhook callback base as it is. */
  preserveIngressUrl?: boolean;
}

/**
 * What every tunnel provider's run hands back: the public URL it established
 * or adopted. Conformance is the point — the tunnel level can notify the
 * gateway the same way no matter which provider ran. The run never holds the
 * calling process open: every provider's tunnel lives in a detached agent
 * (or in tailscaled), so the caller exits as soon as the run returns.
 */
export interface ProviderTunnelResult {
  publicUrl: string;
}

export interface ProviderStopOptions {
  record: TunnelProcessRecord;
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
 * A tunnelable assistant plus the gateway port and workspace the app server fronts.
 */
/**
 * Tell EVERY locally-reachable assistant's gateway the tunnel's public URL:
 * the tunnel fronts one edge, but its ingress domain is app-global info —
 * any assistant the app serves can hand the URL to a session. Best-effort
 * per assistant; one dead gateway never fails the others.
 */
export async function notifyAllLocalGatewaysOfPublicUrl(
  publicUrl: string,
): Promise<void> {
  await Promise.all(
    loadAllAssistants()
      .filter(isLocalEntry)
      .map((entry) => notifyGatewayOfPublicUrl(publicUrl, entry.assistantId)),
  );
}

/**
 * Run a tunnel provider by name — the dispatch `cadet tunnel start` uses, so
 * the command layer never names a provider implementation directly. Notifies
 * every local gateway of the resulting public URL identically for each
 * provider.
 */
export async function runProviderTunnel(
  provider: TunnelProviderName,
  opts: ProviderTunnelOptions,
): Promise<{ publicUrl: string }> {
  const result = await runProvider(provider, opts);
  await notifyAllLocalGatewaysOfPublicUrl(result.publicUrl);
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
