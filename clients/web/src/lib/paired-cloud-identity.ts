import { fetchCloudStatus, isUuid } from "@/lib/local-cloud-identity";
import {
  getLockfileAssistant,
  getPairedGatewayUrl,
  isPairedAssistant,
} from "@/lib/local-mode";

/**
 * One resolved UUID per paired target per session. A miss (unreachable,
 * not yet registered) is evicted so the next ask probes again. Keyed by
 * gateway URL as well as id so a same-name re-pair to another gateway
 * probes again.
 */
const pairedCloudIdCache = new Map<string, Promise<string | null>>();

function pairedCacheKey(assistantId: string): string {
  return `${assistantId}\n${getLockfileAssistant(assistantId)?.runtimeUrl ?? ""}`;
}

export function resetPairedCloudIdentityCacheForTesting(): void {
  pairedCloudIdCache.clear();
}

/**
 * The cloud UUID a paired assistant is registered under, or null.
 *
 * `pairAssistant` keys the lockfile entry by a local slug and the pairing
 * reply carries no platform id, so the entry lacks `cloudAssistantId`
 * until something asks the paired daemon. Its `platform/status` route
 * answers through the same-origin paired proxy (the host injects the
 * guardian bearer, the gateway's runtime-proxy catch-all discards the id in
 * the path), and the UUID is persisted to the entry so `setFromLockfile`
 * carries it from then on. Never throws.
 */
export function resolvePairedAssistantCloudId(
  assistantId: string,
): Promise<string | null> {
  const key = pairedCacheKey(assistantId);
  const cached = pairedCloudIdCache.get(key);
  if (cached) {
    return cached;
  }
  const promise = fetchAndPersistPairedCloudId(assistantId).then((id) => {
    if (id === null) {
      pairedCloudIdCache.delete(key);
    }
    return id;
  });
  pairedCloudIdCache.set(key, promise);
  return promise;
}

async function fetchAndPersistPairedCloudId(
  assistantId: string,
): Promise<string | null> {
  const entry = getLockfileAssistant(assistantId);
  if (!entry) {
    return null;
  }
  if (entry.cloudAssistantId) {
    return entry.cloudAssistantId;
  }
  const pairedUrl = getPairedGatewayUrl(entry);
  if (!pairedUrl) {
    return null;
  }
  // The scoped data plane is plain same-origin /v1 — the trusted host routes
  // it by the id in the path and injects the paired guardian bearer itself.
  const status = await fetchCloudStatus(
    { gatewayUrl: window.location.origin, actorToken: null },
    assistantId,
  );
  const cloudAssistantId = status?.assistantId ?? null;
  if (!cloudAssistantId || !isUuid(cloudAssistantId)) {
    return null;
  }
  // Re-read: a rename or re-pair may have landed while the request was in flight.
  const current = getLockfileAssistant(assistantId);
  if (
    !current ||
    !isPairedAssistant(current) ||
    current.runtimeUrl !== entry.runtimeUrl
  ) {
    return null;
  }
  return cloudAssistantId;
}
