import { webhookDedupCaches } from "../http/routes/webhook-routes.js";

/**
 * Start the email integration's background lifecycle and return its stop
 * thunk: the periodic sweep evicting expired entries from the webhook dedup
 * cache.
 */
export function startEmail(): () => void {
  const { emailDedupCache } = webhookDedupCaches();
  emailDedupCache.startCleanup();
  return () => emailDedupCache.stopCleanup();
}
