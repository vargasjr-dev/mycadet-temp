import { STALE_CLI_UPDATE_HINT } from "../stale-cli-hint.js";
import type {
  TunnelProvider,
  ProviderMeta,
  ProviderTunnelOptions,
} from "../tunnel.js";

/**
 * The managed `cadet` tunnel. It is listed in the shared registry so the
 * command's help and `--provider` validation speak its name, but the tunnel
 * itself ships with Cadet Cloud — until then every run refuses loudly.
 */
export const CADET_TUNNEL_META: ProviderMeta = {
  reach: "Managed tunnel via Cadet Cloud (coming soon)",
  install: "no install needed — included with Cadet Cloud",
  supportsReservedDomain: false,
  comingSoon: true,
};

/** Copy every refusing path shares, so the wording cannot drift apart. */
export function cadetTunnelComingSoonError(provider: string): Error {
  return new Error(
    `Tunnel provider '${provider}' is not yet implemented. ` +
      `If this provider is documented, ${STALE_CLI_UPDATE_HINT}`,
  );
}

/** Refuse the run: the managed tunnel is not something the CLI can start. */
export async function runCadetTunnel(
  _opts: ProviderTunnelOptions,
): Promise<never> {
  throw cadetTunnelComingSoonError("cadet");
}

export const CADET_PROVIDER: TunnelProvider = {
  run: runCadetTunnel,
  async stop() {
    throw cadetTunnelComingSoonError("cadet");
  },
};
