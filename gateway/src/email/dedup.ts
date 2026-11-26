import { StringDedupCache } from "../dedup-cache.js";

let cache: StringDedupCache | undefined;

/**
 * The email webhook dedup cache, born here so every consumer of the gateway
 * process shares one instance: the route table injects it into the webhook
 * handler and the integration lifecycle (lifecycle.ts) sweeps it. A second
 * instance would dedup against a cache nothing ever sweeps.
 */
export function getEmailDedupCache(): StringDedupCache {
  // 24-hour TTL — Message-IDs are globally unique per RFC 5322
  return (cache ??= new StringDedupCache(24 * 60 * 60_000));
}

/** Test isolation: drop the singleton so the next get starts fresh. */
export function resetForTests(): void {
  cache = undefined;
}
