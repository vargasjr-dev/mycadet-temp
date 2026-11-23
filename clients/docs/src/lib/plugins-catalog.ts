import { APEX_ORIGIN } from "@/lib/domains";
// Ported from mycadet-cloud's lib/plugins-catalog — the OSS marketing
// pages fetch the same public catalog the cloud app renders from, so the
// marketplace has one source of truth on the cloud side. The base is the
// web app's public /api surface, which forwards to the cloud-api — this
// repository carries no cloud URL of its own. A failed fetch degrades to
// the honest unavailable state — never a broken page.

export interface CatalogRow {
  name: string;
  repo?: string;
  ref?: string;
  path?: string;
  description?: string;
  icon?: string;
  category?: string;
  homepage?: string;
  license?: string;
  integration?: unknown;
}

export function isCatalogRow(row: unknown): row is CatalogRow {
  if (typeof row !== "object" || row === null || !("name" in row)) {
    return false;
  }
  return typeof row.name === "string";
}

export function catalogRowsFromResponse(data: unknown): CatalogRow[] {
  if (typeof data !== "object" || data === null || !("plugins" in data)) {
    return [];
  }
  const rows: unknown = data.plugins;
  if (!Array.isArray(rows)) {return [];}
  return rows.filter(isCatalogRow);
}

export const PUBLIC_API_BASE = `${APEX_ORIGIN}/api`;

// The loader lives here so the grid and every detail page fetch the SAME
// catalog through the SAME code path — they can't drift. The failure paths
// log loudly: this catch spent two weeks silently eating a real bug in the
// cloud app (a server component calling into a "use client" module), so it
// doesn't get to be quiet again.
export async function loadCatalog(): Promise<CatalogRow[] | null> {
  try {
    const res = await fetch(`${PUBLIC_API_BASE}/plugins`, {
      next: { revalidate: 300 },
    });
    if (!res.ok) {
      console.error(`[plugins] catalog fetch failed: HTTP ${res.status}`);
      return null;
    }
    return catalogRowsFromResponse(await res.json());
  } catch (error) {
    console.error("[plugins] catalog fetch threw:", error);
    return null;
  }
}

export type PluginReadme = { ok: true; content: string } | { ok: false };

/**
 * Fetches the plugin's README from its source repo at the pinned ref.
 * The token header is attached only when GITHUB_TOKEN exists on the
 * environment (private source repos); failures render an honest fallback
 * instead of fake content.
 */
export async function fetchPluginReadme(
  plugin: CatalogRow,
): Promise<PluginReadme> {
  if (!plugin.repo || !plugin.ref) {return { ok: false };}
  const headers: Record<string, string> = {};
  const token = process.env.GITHUB_TOKEN;
  if (token) {headers.Authorization = `Bearer ${token}`;}
  try {
    const res = await fetch(
      `https://raw.githubusercontent.com/${plugin.repo}/${plugin.ref}/README.md`,
      { headers, next: { revalidate: 3600 } },
    );
    if (!res.ok) {return { ok: false };}
    const content = await res.text();
    return content.trim().length > 0 ? { ok: true, content } : { ok: false };
  } catch {
    return { ok: false };
  }
}
