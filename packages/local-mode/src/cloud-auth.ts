import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { resolveConfigDir, resolveLocalConfigFromEnv } from "./config";
import { readLockfile } from "./lockfile";
import { loopbackSafeFetch } from "./loopback-fetch";

/**
 * The platform credential and auth-header logic the operations share with the
 * CLI's cloud client. Lives here so an operation resolves its own
 * credentials — callers never thread a token in (the old host seams passed
 * the Electron session token through the spawn's env; the operation reads
 * the same precedence itself).
 *
 * The CLI's `cloud-client.ts` re-exports these and wraps the one
 * CLI-flavored piece (the `cadet login` recovery hint keyed to the invoking
 * binary's name) on top.
 */

const PLATFORM_FETCH_TIMEOUT_MS = 10_000;

export function cloudTokenPath(): string {
  return join(resolveConfigDir(), "cloud-token");
}

export function readCloudToken(): string | null {
  try {
    return readFileSync(cloudTokenPath(), "utf-8").trim();
  } catch {
    return null;
  }
}

/**
 * Resolve the cloud API base URL. Resolution order:
 *   1. `cloudBaseUrl` persisted on the lockfile when the active assistant
 *      was last hatched/waked — the source of truth for "what URL does the
 *      currently-active assistant target".
 *   2. `CADET_CLOUD_URL` env var (explicit override, e.g. in CI).
 *   3. The current environment's seed URL (e.g. `https://dev-cloud.mycadet.ai`
 *      for `CADET_ENVIRONMENT=dev`, `https://cloud.mycadet.ai` for prod).
 */
export function resolveCloudUrl(): string {
  const url = readLockfile().cloudBaseUrl;
  const lockfileUrl = typeof url === "string" ? url.trim() : undefined;
  return (lockfileUrl && lockfileUrl) || resolveLocalConfigFromEnv().cloudUrl;
}

const VAK_PREFIX = "vak_";

/**
 * Sync helper – returns only the token-based auth header.
 *
 * Used internally by {@link fetchOrganizationId} (which cannot call
 * {@link cloudAuthHeaders} without creating a cycle) and by functions that
 * already have an org ID in hand.
 */
function tokenAuthHeader(token: string): Record<string, string> {
  if (token.startsWith(VAK_PREFIX)) {
    return { Authorization: `Bearer ${token}` };
  }
  return { "X-Session-Token": token };
}

export function authHeadersForKnownOrganization(
  token: string,
  organizationId: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...tokenAuthHeader(token),
  };
  if (!token.startsWith(VAK_PREFIX)) {
    headers["Cadet-Organization-Id"] = organizationId;
  }
  return headers;
}

/** Module-level cache for org IDs to avoid redundant fetches in polling loops. */
const orgIdCache = new Map<string, { orgId: string; expiresAt: number }>();
const ORG_ID_CACHE_TTL_MS = 60_000; // 60 seconds

/**
 * Drop the cached org ID for a given (token, cloudUrl) pair. Used by the
 * one-shot 401-retry path: a 401 on a session-token request frequently means
 * the cached `Cadet-Organization-Id` header is stale (e.g. user switched
 * orgs in another tab). Clearing the entry forces the next auth-headers
 * call to refetch the org ID from the cloud.
 */
export function invalidateOrgIdCache(token: string, cloudUrl?: string): void {
  orgIdCache.delete(`${token}::${cloudUrl ?? ""}`);
}

const OrganizationListResponseSchema = z.object({
  results: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
});

export async function fetchOrganizationId(
  token: string,
  cloudUrl?: string,
): Promise<string> {
  const resolvedUrl = cloudUrl || resolveCloudUrl();
  const url = `${resolvedUrl}/v1/organizations/`;

  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    PLATFORM_FETCH_TIMEOUT_MS,
  );

  try {
    const response = await loopbackSafeFetch(url, {
      signal: controller.signal,
      headers: { ...tokenAuthHeader(token) },
    });

    if (!response.ok) {
      throw new Error(
        `Failed to fetch organizations from ${resolvedUrl} (${response.status}). Try logging in again.`,
      );
    }

    const parsed = OrganizationListResponseSchema.safeParse(
      await response.json(),
    );
    const orgId = parsed.success ? parsed.data.results?.[0]?.id : undefined;
    if (!orgId) {
      throw new Error("No organization found for this account.");
    }
    return orgId;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * The full set of headers needed for an authenticated platform API request:
 * `Content-Type`, the auth header (`Authorization: Bearer` for `vak_` API
 * keys, `X-Session-Token` for session tokens), and — session tokens only —
 * the `Cadet-Organization-Id` fetched from the cloud (cached 60s per
 * (token, cloudUrl)).
 *
 * Errors propagate raw; the CLI's cloud client wraps them with the
 * invoking binary's login hint.
 */
export async function cloudAuthHeaders(
  token: string,
  cloudUrl?: string,
): Promise<Record<string, string>> {
  const base: Record<string, string> = {
    "Content-Type": "application/json",
    ...tokenAuthHeader(token),
  };

  if (token.startsWith(VAK_PREFIX)) {
    // API keys are org-scoped – no need to fetch the org ID.
    return base;
  }

  const cacheKey = `${token}::${cloudUrl ?? ""}`;
  const cached = orgIdCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return { ...base, "Cadet-Organization-Id": cached.orgId };
  }

  const orgId = await fetchOrganizationId(token, cloudUrl);
  orgIdCache.set(cacheKey, {
    orgId,
    expiresAt: Date.now() + ORG_ID_CACHE_TTL_MS,
  });
  return { ...base, "Cadet-Organization-Id": orgId };
}
