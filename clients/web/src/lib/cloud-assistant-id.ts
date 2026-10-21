import { remoteGatewayPublicBaseUrl } from "@/lib/auth/remote-gateway-session";
import { CloudIdentityInjectionError } from "@/lib/cloud-identity-errors";
import {
  getLockfileAssistant,
  getPairedGatewayUrl,
  isCadetCloudRemote,
} from "@/lib/local-mode";
import {
  fetchCloudStatus,
  isUuid,
  resolveLocalAssistantCloudIdentity,
} from "@/lib/local-cloud-identity";
import { getSelfHostedActorToken } from "@/lib/self-hosted/connection";

/**
 * Platform routes such as push-token upsert take a UUID. A self-hosted
 * phone may only know a lockfile slug, a paired id, or remote-gateway
 * `"self"`. Resolve those to the cloud registration; a leftover
 * non-UUID would 404 on Django's `<uuid:assistant_id>` converter.
 */
export async function resolveCloudAssistantId(
  assistantId: string,
): Promise<string | null> {
  if (isUuid(assistantId)) {
    return assistantId;
  }
  try {
    const resolved = await resolveLocalAssistantCloudIdentity(assistantId, {
      allowGatewayRepair: false,
    });
    if (isUuid(resolved)) {
      return resolved;
    }
  } catch (error) {
    // The registration exists even when the local side did not finish.
    if (
      error instanceof CloudIdentityInjectionError &&
      isUuid(error.cloudAssistantId)
    ) {
      return error.cloudAssistantId;
    }
    // A missing lockfile entry or unsigned-in host is not fatal; try
    // the paired and remote-gateway lookups next.
  }
  const paired = await resolvePairedAssistantCloudId(assistantId);
  if (paired && isUuid(paired)) {
    return paired;
  }

  if (!isCadetCloudRemote()) {
    try {
      const status = await fetchCloudStatus(
        {
          gatewayUrl: remoteGatewayPublicBaseUrl(),
          actorToken: getSelfHostedActorToken(),
        },
        assistantId,
      );
      if (status?.assistantId && isUuid(status.assistantId)) {
        return status.assistantId;
      }
    } catch {
      // An unreachable gateway or missing window is not fatal.
    }
  }
  return null;
}

/**
 * The cloud UUID a paired assistant is registered under, or null.
 *
 * `pairAssistant` keys the lockfile entry by a local slug and the pairing
 * reply carries no platform id, so the entry lacks `cloudAssistantId`
 * until something asks the paired daemon. Its `platform/status` route
 * answers through the same-origin paired proxy (the host injects the
 * guardian bearer, the gateway's runtime-proxy catch-all discards the id in
 * the path). Never throws.
 */
async function resolvePairedAssistantCloudId(
  assistantId: string,
): Promise<string | null> {
  const entry = getLockfileAssistant(assistantId);
  if (!entry) {
    return null;
  }
  if (entry.cloudAssistantId) {
    return entry.cloudAssistantId;
  }
  if (!getPairedGatewayUrl(entry)) {
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
  return cloudAssistantId;
}
