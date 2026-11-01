import { remoteGatewayPublicBaseUrl } from "@/lib/auth/remote-gateway-session";
import { CloudIdentityInjectionError } from "@/lib/cloud-identity-errors";
import { isCadetCloudRemote } from "@/lib/local-mode";
import {
  fetchCloudStatus,
  resolveLocalAssistantCloudIdentity,
} from "@/lib/local-cloud-identity";
import { isUuid } from "@/utils/uuid";
import { getSelfHostedActorToken } from "@/lib/self-hosted/connection";

/**
 * Platform routes such as push-token upsert take a UUID. A self-hosted
 * phone may only know a lockfile slug, a paired id, or remote-gateway
 * `"self"`. Resolve those to the cloud registration; a leftover
 * non-UUID would 404 on the cloud's `<uuid:assistant_id>` converter.
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
    // the remote-gateway lookup next.
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
