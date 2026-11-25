import { StringDedupCache } from "../dedup-cache.js";

let cache: StringDedupCache | undefined;

/**
 * The WhatsApp webhook dedup cache, born here so every consumer of the
 * gateway process shares one instance: the route table injects it into the
 * webhook handler and the integration lifecycle (lifecycle.ts) sweeps it. A
 * second instance would dedup against a cache nothing ever sweeps.
 */
export function getWhatsappDedupCache(): StringDedupCache {
  // 24-hour TTL — WhatsApp message IDs are globally unique and never reused
  return (cache ??= new StringDedupCache(24 * 60 * 60_000));
}
