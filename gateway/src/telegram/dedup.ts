import { DedupCache } from "../dedup-cache.js";

let cache: DedupCache | undefined;

/**
 * The Telegram webhook dedup cache, born here so every consumer of the
 * gateway process shares one instance: the route table injects it into the
 * webhook handler and the integration lifecycle (lifecycle.ts) sweeps it. A
 * second instance would dedup against a cache nothing ever sweeps.
 */
export function getTelegramDedupCache(): DedupCache {
  return (cache ??= new DedupCache());
}
