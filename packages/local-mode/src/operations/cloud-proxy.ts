/**
 * Shared plumbing for the operator rows that proxy a dial to the cloud on
 * the OPERATOR's own credentials (the doctor's session surface, the
 * teleport signed-url row). Each row resolves the lockfile entry for the
 * dial's organization header, reads the operator's cloud token (env, else
 * the on-disk token), and hops to the cloud through the loopback-safe
 * fetch with the fixed timeout the non-streaming rows use.
 */

import { authHeadersForKnownOrganization } from "../cloud-auth";
import type { LockfileAssistant } from "../lockfile-contract";
import { readCloudToken, resolveCloudUrl } from "../cloud-auth";

export const UPSTREAM_TIMEOUT_MS = 10_000;

/** The env token, else the on-disk cloud token (the retire leg's order). */
export function readOperatorCloudToken(): string | null {
  const envToken = process.env.CADET_CLOUD_TOKEN?.trim();
  return envToken || readCloudToken();
}

/** The cloud's error body shape the bundles' error parsing already reads. */
export function operatorError(detail: string, status: number): Response {
  return new Response(JSON.stringify({ detail }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The headers one operator cloud dial rides: the operator's token, plus
 * the entry's organization id when the entry carries one.
 */
export function operatorCloudHeaders(
  entry: LockfileAssistant,
  token: string,
): Record<string, string> {
  return entry.cloudOrganizationId?.trim()
    ? authHeadersForKnownOrganization(token, entry.cloudOrganizationId.trim())
    : { Authorization: `Bearer ${token}` };
}

/** The cloud root the proxies dial, without a trailing slash. */
export function cloudOrigin(): string {
  return resolveCloudUrl().replace(/\/+$/, "");
}
