import { OpenAIChatCompletionsProvider } from "../openai/chat-completions-provider.js";

/** LiteLLM proxy's documented default address. */
export const DEFAULT_LITELLM_BASE_URL = "http://localhost:4000";

export interface LiteLLMProviderOptions {
  baseURL?: string;
  streamTimeoutMs?: number;
}

/**
 * LiteLLM is a self-hosted gateway proxy. A stored connection URL wins;
 * otherwise the request goes to the proxy's documented default address —
 * the same fixed-default pattern the other routers (OpenRouter, Vercel AI
 * Gateway) ship in their clients.
 */
export class LiteLLMProvider extends OpenAIChatCompletionsProvider {
  constructor(
    apiKey: string,
    model: string,
    options: LiteLLMProviderOptions = {},
  ) {
    super(apiKey, model, {
      baseURL: options.baseURL?.trim() || DEFAULT_LITELLM_BASE_URL,
      providerName: "litellm",
      providerLabel: "LiteLLM",
      streamTimeoutMs: options.streamTimeoutMs,
      // Replay thinking as `reasoning_content` so DeepSeek-compatible
      // thinking-mode upstreams accept follow-up requests that include tools.
      assistantReasoningField: "reasoning_content",
    });
  }
}
