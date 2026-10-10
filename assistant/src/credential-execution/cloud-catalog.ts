/**
 * Managed CES credential catalog.
 *
 * Discovers cloud OAuth connections by calling the cloud's CES
 * catalog endpoint. Returns displayable descriptors with exact
 * `platform_oauth:<connection_id>` handles suitable for CES tools.
 *
 * This module never reveals token values — it only surfaces handle references
 * and non-secret metadata (provider, account info, scopes, status).
 */

import { platformOAuthHandle } from "@mycadet/service-contracts/credential-rpc";

import { CadetCloudClient } from "../cloud/client.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("cloud-catalog");

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CloudCredentialDescriptor {
  /** CES handle string (e.g. `platform_oauth:conn_abc123`). */
  handle: string;
  /** Source of the credential — always `"platform"` for managed entries. */
  source: "platform";
  /** Provider key on the cloud (e.g. `google`, `slack`). */
  provider: string;
  /** Platform-assigned connection identifier. */
  connectionId: string;
  /** Human-readable account info (e.g. email), if available. */
  accountInfo: string | null;
  /** Granted OAuth scopes, if reported by the cloud. */
  grantedScopes: string[];
  /** Connection status as reported by the cloud (e.g. `active`, `expired`). */
  status: string;
}

// ---------------------------------------------------------------------------
// Platform response shape (non-secret subset)
// ---------------------------------------------------------------------------

/**
 * Shape of a single connection entry in the cloud catalog response.
 * Only non-secret fields are parsed; token values are never included.
 *
 * Field names match the cloud's ManagedConnectionCatalogEntrySerializer:
 *   handle, connection_id, provider, account_label, scopes_granted, status
 */
interface PlatformCatalogEntry {
  handle: string;
  connection_id: string;
  provider: string;
  account_label?: string | null;
  scopes_granted?: string[];
  status?: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface FetchCloudCatalogResult {
  ok: boolean;
  descriptors: CloudCredentialDescriptor[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Cloud connection cache — provides a synchronous view of cloud-managed
// connections for use in the system prompt (which is built synchronously).
// Refresh is triggered at daemon startup and periodically via setInterval.
// ---------------------------------------------------------------------------

export interface CachedManagedConnection {
  provider: string;
  accountInfo: string | null;
}

let cachedConnections: CachedManagedConnection[] = [];

/**
 * Return the last successfully fetched cloud connections.
 * Returns an empty array before the first successful refresh.
 */
export function getCachedManagedConnections(): CachedManagedConnection[] {
  return cachedConnections;
}

/**
 * Fetch cloud connections from the cloud and update the in-memory cache.
 * Best-effort: errors are logged and the cache retains its previous value.
 */
export async function refreshManagedConnectionCache(): Promise<void> {
  const result = await fetchCloudCatalog();
  if (result.ok) {
    cachedConnections = result.descriptors
      .filter((d) => d.status === "active" || d.status === "ACTIVE")
      .map((d) => ({
        provider: d.provider,
        accountInfo: d.accountInfo,
      }));
  }
}

/**
 * Fetch the cloud credential catalog from the cloud.
 *
 * Requires cloud proxy prerequisites (platform base URL + assistant API key).
 * Returns an empty list with `ok: true` when prerequisites are missing —
 * callers should not treat a missing platform as an error.
 *
 * Errors from the cloud are captured and returned as `ok: false` with an
 * error message that never contains secret material.
 */
export async function fetchCloudCatalog(): Promise<FetchCloudCatalogResult> {
  const client = await CadetCloudClient.create();

  if (!client || !client.cloudAssistantId) {
    return { ok: true, descriptors: [] };
  }

  const path = `/v1/assistants/${encodeURIComponent(client.cloudAssistantId)}/oauth/managed/catalog/`;

  try {
    const response = await client.fetch(path, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const statusText = response.statusText || `HTTP ${response.status}`;
      log.warn(
        `Platform CES catalog returned ${response.status}: ${statusText}`,
      );
      return {
        ok: false,
        descriptors: [],
        error: `Platform CES catalog request failed (${response.status})`,
      };
    }

    // The cloud returns a flat JSON array of catalog entries
    // (serialized with many=True), not a wrapper object.
    const body = (await response.json()) as PlatformCatalogEntry[];

    if (!Array.isArray(body)) {
      return {
        ok: false,
        descriptors: [],
        error: "Platform CES catalog returned unexpected response format",
      };
    }

    const descriptors: CloudCredentialDescriptor[] = body.map((entry) => ({
      handle: platformOAuthHandle(entry.connection_id),
      source: "platform" as const,
      provider: entry.provider,
      connectionId: entry.connection_id,
      accountInfo: entry.account_label ?? null,
      grantedScopes: entry.scopes_granted ?? [],
      status: entry.status ?? "unknown",
    }));

    return { ok: true, descriptors };
  } catch (err) {
    const errorName = err instanceof Error ? err.constructor.name : "Unknown";
    log.warn(`Failed to fetch managed CES catalog (${errorName})`);
    return {
      ok: false,
      descriptors: [],
      error: `Failed to fetch managed CES catalog (${errorName})`,
    };
  }
}
