/**
 * Pure default-provider read helpers — no `config/loader` imports, by design.
 * Route handlers (and their tests, which often partially mock the loader)
 * import from here so that pulling default-provider logic into a module graph
 * never drags write-side loader exports along with it. Loader-coupled
 * conveniences (`getDefaultProvider()` without an argument,
 * `setDefaultProvider`) live in `default-provider.ts`.
 */
import { CADET_MANAGED_CONNECTION_NAME } from "../providers/cadet-model-routing.js";
import { CHATGPT_SUBSCRIPTION_CONNECTION_NAME } from "../providers/inference/auth.js";
import { type DefaultProviderConfig,isDefaultProviderChoice } from "./schemas/llm.js";
import type { AssistantConfig } from "./types.js";

/**
 * The default-provider selection carried by an `llm.default` blob, clamped.
 * The blob stores `provider` as the loose provider set, so the read narrows
 * it to a choice the intent × provider matrix can implement
 * (`isDefaultProviderChoice`); anything else — a keyless provider like
 * ollama, a user-endpoint provider like openai-compatible, garbage, or no
 * blob at all — reads as `null`, which resolution treats as the managed
 * column. Accepts unknown so raw and parsed blobs take the same path.
 */
export function readDefaultProvider(
  llmDefault: unknown,
): DefaultProviderConfig | null {
  const blob =
    llmDefault != null &&
    typeof llmDefault === "object" &&
    !Array.isArray(llmDefault)
      ? (llmDefault as Record<string, unknown>)
      : null;
  const provider = blob?.provider;
  if (typeof provider !== "string" || !isDefaultProviderChoice(provider)) {
    return null;
  }
  const connectionName = blob?.provider_connection;
  return {
    provider,
    ...(typeof connectionName === "string" && connectionName !== ""
      ? { connectionName }
      : {}),
  };
}

export function getDefaultProviderFromConfig(
  config: AssistantConfig,
): DefaultProviderConfig | null {
  return readDefaultProvider(config.llm.default);
}

/**
 * Pure by design — no connection-existence check. A dangling name (explicit
 * or conventional) is allowed; the stored blob carries the same freedom (see
 * `LLMDefaultConfigSchema`).
 */
export function resolveDefaultConnectionName(
  dp: DefaultProviderConfig,
): string {
  if (dp.connectionName) {
    return dp.connectionName;
  }
  if (dp.provider === "cadet") {
    return CADET_MANAGED_CONNECTION_NAME;
  }
  if (dp.provider === "chatgpt") {
    return CHATGPT_SUBSCRIPTION_CONNECTION_NAME;
  }
  return `${dp.provider}-personal`;
}
