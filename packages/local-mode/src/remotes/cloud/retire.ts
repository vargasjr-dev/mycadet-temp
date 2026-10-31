import {
  authHeadersForKnownOrganization,
  cloudAuthHeaders,
  readCloudToken,
  resolveCloudUrl,
} from "../../cloud-auth";
import { loopbackSafeFetch } from "../../loopback-fetch";
import { getGatewayUrl } from "../../lockfile-contract";
import type { LockfileAssistant } from "../../lockfile-contract";

/**
 * The cloud remote's retire leg: DELETE the assistant's platform record and
 * the platform registration a self-hosted entry holds. Credentials are
 * resolved HERE (env token → the on-disk cloud token) — callers never pass a
 * token in; the operation is headless about where the session lives.
 */

export interface CloudRetireToken {
  token: string | null;
}

/**
 * The platform credential for unregistration: the host's injected session
 * token env (`CADET_CLOUD_TOKEN`, or its legacy `CADET_PLATFORM_TOKEN`
 * spelling) wins, else the CLI's persisted cloud token.
 */
export function readPlatformRetireToken(): string | null {
  const envToken = (
    process.env.CADET_CLOUD_TOKEN ?? process.env.CADET_PLATFORM_TOKEN
  )?.trim();
  if (envToken) return envToken;
  return readCloudToken();
}

function nonEmptyString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export async function deleteCloudAssistant(
  assistantId: string,
  options: {
    token: string;
    cloudUrl?: string;
    organizationId?: string;
    label: string;
    successMessage: string;
    alreadyGoneMessage: string;
  },
): Promise<void> {
  const cloudUrl = options.cloudUrl || resolveCloudUrl();
  const url = `${cloudUrl}/v1/assistants/${encodeURIComponent(assistantId)}/retire/`;
  const headers = options.organizationId
    ? authHeadersForKnownOrganization(options.token, options.organizationId)
    : await cloudAuthHeaders(options.token, cloudUrl);

  const response = await loopbackSafeFetch(url, {
    method: "DELETE",
    headers,
  });

  if (!response.ok && response.status !== 404) {
    const body = await response.text();
    throw new Error(`${options.label} failed (${response.status}): ${body}`);
  }

  if (response.status === 404) {
    console.log(options.alreadyGoneMessage);
  } else {
    console.log(options.successMessage);
  }
}

/**
 * Unregister the platform record a SELF-HOSTED entry (local/docker/
 * apple-container) holds: the entry's registration trio names the cloud
 * assistant; a 404 means it is already gone.
 */
export async function unregisterSelfHostedLocalPlatformRecord(
  entry: LockfileAssistant,
): Promise<void> {
  const token = readPlatformRetireToken();
  if (!token) return;

  const cloudAssistantId =
    entry.cloud === "custom" || entry.cloud === "baseten"
      ? undefined
      : nonEmptyString(entry.cloudAssistantId);
  if (!cloudAssistantId) return;

  await deleteCloudAssistant(cloudAssistantId, {
    token,
    cloudUrl: resolveCloudUrl(),
    organizationId:
      entry.cloud === "custom" || entry.cloud === "baseten"
        ? undefined
        : (nonEmptyString(entry.cloudOrganizationId) ?? undefined),
    label: "Platform self-hosted unregister",
    successMessage: "✅ Platform self-hosted registration unregistered.",
    alreadyGoneMessage:
      "✅ Platform self-hosted registration already unregistered (404).",
  });
}

/**
 * Retire a platform-hosted (cloud) entry: the same DELETE, addressed at the
 * entry's own gateway URL. Throws when no platform credential resolves — the
 * CLI surfaces it as its not-logged-in error.
 */
export async function retireCloudEntry(
  entry: LockfileAssistant,
): Promise<void> {
  console.log("\u{1F5D1}\ufe0f  Retiring Cadet Cloud-hosted instance...\n");

  const token = readPlatformRetireToken();
  if (!token) {
    throw new Error("Not logged in. Run `cadet login --token <token>` first.");
  }

  await deleteCloudAssistant(entry.assistantId, {
    token,
    cloudUrl: getGatewayUrl(entry),
    label: "Platform retire",
    successMessage: "\u2705 Platform-hosted instance retired.",
    alreadyGoneMessage:
      "\u2705 Platform-hosted instance already retired (404) \u2014 cleaning up local state.",
  });
}
