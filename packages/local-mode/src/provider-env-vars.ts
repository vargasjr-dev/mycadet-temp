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
