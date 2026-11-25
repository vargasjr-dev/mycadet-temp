import { getWhatsappDedupCache } from "./dedup.js";

/**
 * Start the WhatsApp integration's background lifecycle and return its stop
 * thunk: the periodic sweep evicting expired entries from the webhook dedup
 * cache.
 */
export function startWhatsapp(): () => void {
  const dedupCache = getWhatsappDedupCache();
  dedupCache.startCleanup();
  return () => dedupCache.stopCleanup();
}
