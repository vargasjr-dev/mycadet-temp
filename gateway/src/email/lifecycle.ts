import { getEmailDedupCache } from "./dedup.js";

/**
 * Start the email integration's background lifecycle and return its stop
 * thunk: the periodic sweep evicting expired entries from the webhook dedup
 * cache.
 */
export function startEmail(): () => void {
  const dedupCache = getEmailDedupCache();
  dedupCache.startCleanup();
  return () => dedupCache.stopCleanup();
}
