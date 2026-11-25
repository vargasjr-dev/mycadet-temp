import { webhookDedupCaches } from "../http/routes/webhook-routes.js";

/**
 * Start the Telegram integration's background lifecycle and return its stop
 * thunk: the periodic sweep evicting expired entries from the webhook dedup
 * cache.
 */
export function startTelegram(): () => void {
  const { telegramDedupCache } = webhookDedupCaches();
  telegramDedupCache.startCleanup();
  return () => telegramDedupCache.stopCleanup();
}
