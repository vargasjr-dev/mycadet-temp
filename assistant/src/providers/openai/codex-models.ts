import { CODEX_SUBSCRIPTION_MODEL_IDS } from "../../api/constants/codex-models.js";

/**
 * Whether a model ID is servable through the ChatGPT Codex subscription
 * endpoint. The allowlist itself lives in
 * `@mycadet/assistant-api` (`src/api/constants/codex-models.ts`) so the
 * web client imports the same set the daemon enforces.
 */
export function isCodexSubscriptionModel(model: string): boolean {
  return CODEX_SUBSCRIPTION_MODEL_IDS.has(model);
}
