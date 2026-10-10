import { CADET_MANAGED_CONNECTION_NAME } from "../providers/cadet-model-routing.js";
import { CHATGPT_SUBSCRIPTION_CONNECTION_NAME } from "../providers/inference/auth.js";
import {
  isDefaultProviderChoice,
  type LLMDefaultConfig,
} from "./schemas/llm.js";

/**
 * The connection the default provider dispatches through: an explicit
 * `provider_connection` pin, else the per-provider convention name. Returns
 * null when the blob carries no provider the intent × provider matrix can
 * implement — there is no connection to resolve. Pure by design — no
 * connection-existence check; a dangling name is allowed.
 */
export function resolveDefaultConnectionName(
  dp: LLMDefaultConfig | undefined,
): string | null {
  const provider = dp?.provider;
  if (provider == null || !isDefaultProviderChoice(provider)) {
    return null;
  }
  if (dp?.provider_connection) {
    return dp.provider_connection;
  }
  if (provider === "cadet") {
    return CADET_MANAGED_CONNECTION_NAME;
  }
  if (provider === "chatgpt") {
    return CHATGPT_SUBSCRIPTION_CONNECTION_NAME;
  }
  return `${provider}-personal`;
}
