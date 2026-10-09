import { CADET_MANAGED_CONNECTION_NAME } from "../providers/cadet-model-routing.js";
import { CHATGPT_SUBSCRIPTION_CONNECTION_NAME } from "../providers/inference/auth.js";
import { type DefaultProviderConfig } from "./schemas/llm.js";

/** Pure by design — no connection-existence check; a dangling name is allowed. */
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
