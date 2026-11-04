/**
 * LLM provider env var names, keyed by provider ID. Mirrors the assistant
 * daemon's `PROVIDER_CATALOG` entries with an `envVar`; drift is caught by
 * the CLI's parity tests.
 */
export const LLM_PROVIDER_ENV_VAR_NAMES: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  fireworks: "FIREWORKS_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  "vercel-ai-gateway": "AI_GATEWAY_API_KEY",
  minimax: "MINIMAX_API_KEY",
  atlascloud: "ATLASCLOUD_API_KEY",
  together: "TOGETHER_API_KEY",
  litellm: "LITELLM_API_KEY",
  opencode: "OPENCODE_API_KEY",
  baseten: "BASETEN_API_KEY",
  ionet: "IONET_API_KEY",
  poolside: "POOLSIDE_API_KEY",
  typesafe: "TYPESAFE_API_KEY",
};

/**
 * Search-provider env var names. Mirrors `SEARCH_PROVIDER_CATALOG` BYOK
 * entries — locally-maintained mirror of the canonical catalog in
 * `assistant/src/providers/`; drift is caught by the CLI's parity tests.
 */
export const SEARCH_PROVIDER_ENV_VAR_NAMES: Record<string, string> = {
  perplexity: "PERPLEXITY_API_KEY",
  brave: "BRAVE_API_KEY",
  tavily: "TAVILY_API_KEY",
  firecrawl: "FIRECRAWL_API_KEY",
  keenable: "KEENABLE_API_KEY",
  fastcrw: "FASTCRW_API_KEY",
  searxng: "SEARXNG_API_KEY",
  tinyfish: "TINYFISH_API_KEY",
  exa: "EXA_API_KEY",
  serply: "SERPLY_API_KEY",
};

/**
 * Combined provider env var names — the union of LLM and search providers.
 * Used by the container/VM provisioning flows to forward every supported
 * provider API key from the caller's environment; the call sites don't need
 * to know which kind is which — they just forward every value whose env var
 * is set.
 */
export const PROVIDER_ENV_VAR_NAMES: Record<string, string> = {
  ...LLM_PROVIDER_ENV_VAR_NAMES,
  ...SEARCH_PROVIDER_ENV_VAR_NAMES,
};
