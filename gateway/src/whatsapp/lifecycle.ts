import { webhookDedupCaches } from "../http/routes/webhook-routes.js";

/**
 * Start the WhatsApp integration's background lifecycle and return its stop
 * thunk: the periodic sweep evicting expired entries from the webhook dedup
 * cache.
 */
export function startWhatsapp(): () => void {
  const { whatsappDedupCache } = webhookDedupCaches();
  whatsappDedupCache.startCleanup();
  return () => whatsappDedupCache.stopCleanup();
}
