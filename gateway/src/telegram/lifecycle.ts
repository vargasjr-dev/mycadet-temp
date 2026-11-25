import { getTelegramDedupCache } from "./dedup.js";

/**
 * Start the Telegram integration's background lifecycle and return its stop
 * thunk: the periodic sweep evicting expired entries from the webhook dedup
 * cache.
 */
export function startTelegram(): () => void {
  const dedupCache = getTelegramDedupCache();
  dedupCache.startCleanup();
  return () => dedupCache.stopCleanup();
}
