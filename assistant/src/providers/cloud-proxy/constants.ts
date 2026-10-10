/**
 * Provider metadata for cloud proxy routing.
 *
 * Each managed-capable provider maps to a deterministic proxy base path
 * used when routing LLM requests through the cloud's cloud proxy.
 * Providers marked as non-managed (e.g. ollama) are excluded.
 */

export interface CloudProviderMeta {
  /** Provider identifier matching the registry name. */
  name: string;
  /** Whether this provider supports cloud proxy routing. */
  managed: boolean;
  /** Proxy path segment appended to the cloud base URL (only for cloud providers). */
  proxyPath?: string;
}

/**
 * Explicit provider metadata for all known providers.
 * Cloud providers get a deterministic proxy path; non-cloud providers
 * are marked accordingly and have no proxy path.
 *
 * This table describes cloud proxy routing capability only. It does not
 * control which providers auto-bootstrap into the text-model registry when
 * cloud credentials are present; that policy lives in the registry/context
 * fallback allowlists.
 */
export const PLATFORM_PROVIDER_META: Record<string, CloudProviderMeta> = {
  openai: {
    name: "openai",
    managed: true,
    proxyPath: "/v1/runtime-proxy/openai",
  },
  anthropic: {
    name: "anthropic",
    managed: true,
    proxyPath: "/v1/runtime-proxy/anthropic",
  },
  gemini: {
    name: "gemini",
    managed: true,
    proxyPath: "/v1/runtime-proxy/gemini",
  },
  fireworks: {
    name: "fireworks",
    managed: true,
    proxyPath: "/v1/runtime-proxy/fireworks",
  },
  together: {
    name: "together",
    managed: true,
    proxyPath: "/v1/runtime-proxy/together",
  },
  cadet: {
    name: "cadet",
    managed: true,
    // Wire contract with the cloud's runtime proxy — the route segment
    // is renamed in coordination with the cloud deploy, not here.
    proxyPath: "/v1/runtime-proxy/cadet",
  },
  typesafe: {
    name: "typesafe",
    managed: true,
    proxyPath: "/v1/runtime-proxy/typesafe",
  },
  poolside: {
    name: "poolside",
    managed: false,
  },
  openrouter: {
    name: "openrouter",
    managed: false,
  },
  "vercel-ai-gateway": {
    name: "vercel-ai-gateway",
    managed: false,
  },
  ollama: { name: "ollama", managed: false },
  "openai-compatible": { name: "openai-compatible", managed: false },
};
