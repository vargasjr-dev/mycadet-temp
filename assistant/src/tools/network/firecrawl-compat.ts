/**
 * Shared helpers for Firecrawl-compatible scrape/search HTTP APIs
 * (Firecrawl hosted `/v2/*` and fastCRW `/v1/*`).
 */

import { z } from "zod";

import { isPlainObject } from "../../util/object.js";

export const FASTCRW_DEFAULT_API_BASE = "https://api.fastcrw.com";

/**
 * Join an API origin with a path. Empty / whitespace `apiBase` uses
 * `defaultBase`. Trailing slashes on the base are stripped.
 */
export function resolveProviderApiUrl(
  apiBase: string | undefined,
  path: string,
  defaultBase: string,
): string {
  const trimmed = apiBase?.trim() ?? "";
  const origin = (trimmed.length > 0 ? trimmed : defaultBase).replace(
    /\/+$/,
    "",
  );
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${origin}${normalizedPath}`;
}

export interface FirecrawlCompatSearchResult {
  title?: string;
  description?: string;
  snippet?: string;
  url?: string;
  category?: string;
}

/** The zod schema that actually guarantees a search row's field types. */
export const FirecrawlCompatSearchResultSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  snippet: z.string().optional(),
  url: z.string().optional(),
  category: z.string().optional(),
});

/** A search payload row, validated by its zod schema (a plain-object check
 * alone says nothing about the field types). */
function isSearchRow(value: unknown): value is FirecrawlCompatSearchResult {
  return FirecrawlCompatSearchResultSchema.safeParse(value).success;
}

/**
 * Portable read of Firecrawl / fastCRW search payloads:
 * - grouped: `data.web` (Firecrawl `/v2/search`, hosted CRW with sources)
 * - self-hosted with sources: `data.results.web` (object keyed by source)
 * - self-hosted flat: `data.results` (array)
 * - hosted flat: `data` is the array itself
 */
export function extractFirecrawlCompatSearchResults(
  data: unknown,
): FirecrawlCompatSearchResult[] {
  if (!isPlainObject(data)) {
    return [];
  }
  const payload = data.data;

  if (Array.isArray(payload)) {
    return payload.filter(isSearchRow);
  }

  if (isPlainObject(payload)) {
    if (Array.isArray(payload.web)) {
      return payload.web.filter(isSearchRow);
    }
    // Self-hosted CRW with sources:["web"] nests rows under data.results.web
    // (an object keyed by source), not data.results as a flat array.
    if (isPlainObject(payload.results)) {
      const resultsBySource = payload.results;
      if (Array.isArray(resultsBySource.web)) {
        return resultsBySource.web.filter(isSearchRow);
      }
      for (const rows of Object.values(resultsBySource)) {
        if (Array.isArray(rows)) {
          return rows.filter(isSearchRow);
        }
      }
    }
    if (Array.isArray(payload.results)) {
      return payload.results.filter(isSearchRow);
    }
  }

  return [];
}

export function searchResultSnippet(
  result: FirecrawlCompatSearchResult,
): string | undefined {
  const text = result.description || result.snippet;
  return text?.trim() || undefined;
}
