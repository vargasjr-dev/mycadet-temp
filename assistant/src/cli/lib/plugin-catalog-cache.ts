/**
 * In-memory cache for the installable plugin catalog.
 *
 * The catalog is fetched from Cadet Cloud (`CADET_CLOUD_URL`, overridable for
 * air-gapped installs) and any fetch failure propagates (fail hard — no
 * stale-cache smoothing). Successful loads are held per git ref for a short
 * TTL.
 */

import { fetchPluginCatalogFromPlatform } from "./plugin-catalog-cloud.js";
import type { PluginCatalog, SearchPluginsDeps } from "./search-plugins.js";

/** How long a fetched catalog is served before a refresh is attempted. */
export const PLUGIN_CATALOG_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry {
  catalog: PluginCatalog;
  timestamp: number;
}

type PluginCatalogLoadDeps = Pick<SearchPluginsDeps, "fetch">;

const cache = new Map<string, CacheEntry>();

/**
 * Resolve the full installable plugin catalog at {@link ref}.
 *
 * The catalog is fetched from the cloud and, on success, cached per ref for
 * the TTL; a fetch failure propagates so the caller can surface it (e.g. map
 * a rate-limit to 503) — no stale catalog is ever served.
 */
export async function getPluginCatalog(
  ref: string,
  deps: PluginCatalogLoadDeps,
): Promise<PluginCatalog> {
  const cached = cache.get(ref);
  if (cached && Date.now() - cached.timestamp < PLUGIN_CATALOG_CACHE_TTL_MS) {
    return cached.catalog;
  }

  const catalog = await fetchPluginCatalogFromPlatform(deps, { ref });
  cache.set(ref, { catalog, timestamp: Date.now() });
  return catalog;
}

/** Category metadata for plugins already installed. */
export async function getPluginCatalogForInstalledMetadata(
  ref: string,
  deps: PluginCatalogLoadDeps,
): Promise<PluginCatalog> {
  return getPluginCatalog(ref, deps);
}

/** Invalidate the cache (for testing or forced refresh). */
export function invalidatePluginCatalogCache(): void {
  cache.clear();
}
