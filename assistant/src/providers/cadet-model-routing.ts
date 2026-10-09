/**
 * Codec for Cadet-managed model routing strings.
 *
 * A single `cadet` provider connection is provider-agnostic: unlike the
 * per-provider `*-managed` connections it does not carry the upstream provider
 * on its DB row. The upstream provider therefore has to travel *with* the
 * model. Where a routing site has the provider as a sibling field it uses that
 * directly; where only a single model string is available (telemetry headers
 * like `X-Cadet-Resolved-Model`, persisted model overrides, display), the
 * provider is encoded as a `<provider>/<model>` prefix, e.g.
 * `fireworks/accounts/fireworks/models/minimax-m3`.
 *
 * This module is the single source of truth for that encoding. It is a pure
 * codec — no I/O, no wiring — so it can be adopted incrementally.
 */

import {
  getCatalogProviderForModel,
  isModelInCatalog,
} from "./model-catalog.js";
import { PLATFORM_PROVIDER_META } from "./platform-proxy/constants.js";

/**
 * Provider ids that can front a Cadet-managed (platform-proxied) route.
 * Only these are valid prefixes for a routing string; everything else
 * (openrouter, ollama, openai-compatible, or a raw native model id) is not a
 * Cadet-routed string and `parseCadetModel` returns null for it.
 */
export const MANAGED_ROUTABLE_PROVIDERS: ReadonlySet<string> = new Set(
  Object.values(PLATFORM_PROVIDER_META)
    .filter((m) => m.managed)
    .map((m) => m.name),
);

/**
 * Sentinel provider id for the single, provider-agnostic Cadet-managed
 * connection. Unlike the per-provider `*-managed` connections, this one does
 * not name an upstream provider on its DB row — the upstream is determined
 * per-request from the resolving profile. The same id is the catalog owner
 * of Cadet-hosted GPU models. Dispatch translates the identity to a
 * factory id (including `cadet` when that is the catalog owner) before
 * adapter lookup.
 */
export const CADET_MANAGED_PROVIDER = "cadet";

/**
 * Name of the single provider-agnostic Cadet-managed connection row. The
 * connection carries platform auth and the `cadet` sentinel instead of a
 * real upstream; the upstream is chosen per-request from the resolving
 * profile's provider. Lives in this pure module (rather than
 * `inference/connections.ts`, which re-exports it) so leaf consumers like the
 * default-profile catalog can reference it without importing the
 * DB-connected module graph.
 */
export const CADET_MANAGED_CONNECTION_NAME = "cadet";

/**
 * Whether a connection is the provider-agnostic Cadet-managed connection.
 * The provider column alone identifies the managed route: platform auth
 * always accompanies it (auth derivation pairs them, the connection routes
 * reject writes that split them, and DB migration 361 reconciles stored
 * rows).
 * Structurally typed so this stays a pure module with no connection-schema
 * import.
 */
export function isCadetManagedConnection(conn: { provider: string }): boolean {
  return conn.provider === CADET_MANAGED_PROVIDER;
}

export interface CadetModelRoute {
  /** Upstream provider id, e.g. "fireworks". Always a managed-routable id. */
  provider: string;
  /** Native upstream model id, slashes intact, e.g. "accounts/fireworks/models/minimax-m3". */
  model: string;
}

/**
 * Encode a provider + native model id into a Cadet routing string.
 * Throws on a non-routable provider — that is a caller bug, not user input.
 */
export function formatCadetModel(provider: string, model: string): string {
  if (!MANAGED_ROUTABLE_PROVIDERS.has(provider)) {
    throw new Error(
      `formatCadetModel: "${provider}" is not a Cadet-managed provider ` +
        `(expected one of ${[...MANAGED_ROUTABLE_PROVIDERS].join(", ")})`,
    );
  }
  if (!model) {
    throw new Error("formatCadetModel: model must be non-empty");
  }
  return `${provider}/${model}`;
}

/**
 * Decode a Cadet routing string back into provider + native model id.
 *
 * Splits on the FIRST slash only so native ids that themselves contain
 * slashes (Fireworks `accounts/fireworks/models/...`) round-trip losslessly.
 * Returns null when the string is not a Cadet-routed model — no slash, empty
 * model, or a prefix that is not a managed-routable provider.
 *
 * Note: `anthropic/…` is also OpenRouter's native id shape, so this codec
 * must only be applied in a Cadet-connection context. OpenRouter is
 * `managed:false` and never routes through a cadet connection, so the
 * collision is unreachable in practice; the guard here is belt-and-suspenders.
 */
export function parseCadetModel(routingString: string): CadetModelRoute | null {
  const slash = routingString.indexOf("/");
  if (slash <= 0) {
    return null;
  }
  const provider = routingString.slice(0, slash);
  const model = routingString.slice(slash + 1);
  if (!model) {
    return null;
  }
  if (!MANAGED_ROUTABLE_PROVIDERS.has(provider)) {
    return null;
  }
  return { provider, model };
}

/**
 * Resolve the managed upstream provider for a model referenced by a
 * `provider: "cadet"` profile. Such a profile carries no upstream of its own,
 * so the model alone determines it: a `<provider>/<model>` routing string
 * names the upstream directly, and a bare id resolves to its catalog owner.
 * Returns null when the model has no managed-routable upstream (unknown id,
 * or owned by a non-managed provider like openrouter).
 *
 * A decoded routing string must also name a real catalog model under its
 * prefix: OpenRouter/Vercel native ids share the `<provider>/<model>` shape
 * (e.g. `anthropic/…`), so an unvalidated prefix match could route an
 * arbitrary non-managed id through the managed proxy.
 */
export function getManagedUpstream(model: string): string | null {
  const route = parseCadetModel(model);
  if (route) {
    return isModelInCatalog(route.provider, route.model)
      ? route.provider
      : null;
  }
  const owner = getCatalogProviderForModel(model);
  return owner !== undefined && MANAGED_ROUTABLE_PROVIDERS.has(owner)
    ? owner
    : null;
}
