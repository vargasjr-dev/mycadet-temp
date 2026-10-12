/**
 * In-memory cache for the installable plugin catalog.
 *
 * Platform-first: when platform features are enabled the catalog is fetched
 * from Cadet Cloud and any fetch failure propagates (fail hard — no
 * stale-cache smoothing). Successful loads are held per git ref for a short
 * TTL. When `CADET_DISABLE_CLOUD` disables platform features there is no
 * catalog to serve — the installable catalog is cloud-only, so the result is
 * empty (installs by GitHub URL keep working).
 */

import { areCloudFeaturesEnabled } from "../../cloud/feature-gate.js";
import { fetchPluginCatalogFromPlatform } from "./plugin-catalog-cloud.js";
import { readBundledLocalPluginCatalog } from "./plugin-catalog-local.js";
import { filterPluginCatalogByFeatureFlags } from "./plugin-catalog-visibility.js";
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
 * Add bundled local packages without overriding cloud-authoritative rows.
 * A platform row without an integration borrows the bundled row's
 * integration of the same name, so an integration the cloud omits or
 * serves malformed never disappears from the catalog.
 */
export function mergePlatformCatalogWithBundledLocals(
  platform: PluginCatalog,
  bundledLocal: PluginCatalog = readBundledLocalPluginCatalog(),
): PluginCatalog {
  const bundledByName = new Map(
    bundledLocal.matches.map((match) => [match.name, match]),
  );
  const platformMatches = platform.matches.map((match) => {
    const bundledIntegration = bundledByName.get(match.name)?.integration;
    if (match.integration || !bundledIntegration) {
      return match;
    }
    return { ...match, integration: bundledIntegration };
  });
  const seen = new Set(platform.matches.map((match) => match.name));
  return {
    ref: platform.ref,
    matches: [
      ...platformMatches,
      ...bundledLocal.matches.filter((match) => !seen.has(match.name)),
    ].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/**
 * Resolve the full plugin catalog at {@link ref}.
 *
 * With platform features disabled the catalog is empty — installs by name
 * need the cloud. Otherwise the catalog is fetched from the cloud and, on
 * success, cached per ref for the TTL; a fetch failure propagates so the
 * caller can surface it (e.g. map a rate-limit to 503) — no stale catalog is
 * ever served.
 */
async function loadPluginCatalog(
  ref: string,
  deps: PluginCatalogLoadDeps,
): Promise<PluginCatalog> {
  if (!areCloudFeaturesEnabled()) {
    return { ref, matches: [] };
  }

  const cached = cache.get(ref);
  if (cached && Date.now() - cached.timestamp < PLUGIN_CATALOG_CACHE_TTL_MS) {
    return cached.catalog;
  }

  const catalog = await fetchPluginCatalogFromPlatform(deps, { ref });
  const merged = mergePlatformCatalogWithBundledLocals(catalog);
  cache.set(ref, { catalog: merged, timestamp: Date.now() });
  return merged;
}

/** Installable catalog with feature-flag visibility applied. */
export async function getPluginCatalog(
  ref: string,
  deps: SearchPluginsDeps,
): Promise<PluginCatalog> {
  return filterPluginCatalogByFeatureFlags(
    await loadPluginCatalog(ref, deps),
    deps.featureFlagEnabled,
  );
}

/** Category metadata for plugins already installed, including hidden entries. */
export async function getPluginCatalogForInstalledMetadata(
  ref: string,
  deps: PluginCatalogLoadDeps,
): Promise<PluginCatalog> {
  return loadPluginCatalog(ref, deps);
}

/** Invalidate the cache (for testing or forced refresh). */
export function invalidatePluginCatalogCache(): void {
  cache.clear();
}
