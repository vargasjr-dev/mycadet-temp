import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { resolveCloudBaseUrl } from "../config/env.js";
import { getLogger } from "../util/logger.js";
import { getObjectProperty } from "../util/object.js";
import { getRepoSkillsDir } from "./catalog-install.js";

const log = getLogger("categories-cache");
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const skillCategorySchema = z.looseObject({
  slug: z.string(),
  label: z.string(),
  description: z.string(),
  icon: z.string(),
});

export type SkillCategoryDef = z.infer<typeof skillCategorySchema>;

function readCategories(categories: unknown[]): SkillCategoryDef[] {
  return categories.flatMap((category) => {
    const parsed = skillCategorySchema.safeParse(category);
    return parsed.success ? [parsed.data] : [];
  });
}

let cachedCategories: SkillCategoryDef[] | null = null;
let cacheTimestamp = 0;

async function fetchCategories(): Promise<SkillCategoryDef[]> {
  const cloudUrl = resolveCloudBaseUrl();
  const url = `${cloudUrl}/v1/skills/categories/`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(
      `Cloud API error ${response.status}: ${response.statusText}`,
    );
  }

  const data: unknown = await response.json();
  const categories = getObjectProperty(data, "categories");
  if (!Array.isArray(categories)) {
    throw new Error(
      "Platform categories response has invalid categories array",
    );
  }
  return readCategories(categories);
}

function readLocalCategories(repoSkillsDir: string): SkillCategoryDef[] {
  try {
    const raw = readFileSync(
      join(repoSkillsDir, "skill-categories-catalog.yaml"),
      "utf-8",
    );
    const parsed: unknown = parseYaml(raw);
    const categories = getObjectProperty(parsed, "categories");
    if (!Array.isArray(categories)) {
      return [];
    }
    return readCategories(categories);
  } catch {
    return [];
  }
}

export async function getCategories(): Promise<SkillCategoryDef[]> {
  if (cachedCategories && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedCategories;
  }

  const repoSkillsDir = getRepoSkillsDir();
  const local = repoSkillsDir ? readLocalCategories(repoSkillsDir) : [];
  let categories: SkillCategoryDef[];

  try {
    const remote = await fetchCategories();
    if (local.length > 0) {
      const localSlugs = new Set(local.map((c) => c.slug));
      categories = [...local, ...remote.filter((c) => !localSlugs.has(c.slug))];
    } else {
      categories = remote;
    }
  } catch (err) {
    if (cachedCategories) {
      log.warn(
        { err },
        "Failed to fetch skill categories, keeping stale cache",
      );
      cacheTimestamp = Date.now();
      return cachedCategories;
    }
    if (local.length > 0) {
      log.warn(
        { err },
        "Failed to fetch skill categories, falling back to bundled local catalog",
      );
      categories = local;
    } else {
      log.warn({ err }, "Failed to fetch skill categories, returning empty");
      return [];
    }
  }

  cachedCategories = categories;
  cacheTimestamp = Date.now();
  return categories;
}

function getCachedCategoriesSync(): SkillCategoryDef[] {
  return cachedCategories ?? [];
}

/**
 * Valid Skills category slugs, read synchronously from the bundled
 * `skill-categories-catalog.yaml`. Local + sync so callers that must stay off
 * the remote path (e.g. the plugins list) get the shared taxonomy without
 * remote-fetch latency. Resolves the catalog across environments and degrades
 * to an empty set when it is unreachable — callers treat an empty set as
 * "everything is unknown" rather than failing.
 */
export function getLocalCategorySlugs(): Set<string> {
  const repoSkillsDir = getRepoSkillsDir();
  if (repoSkillsDir) {
    const slugs = readLocalCategories(repoSkillsDir).map((c) => c.slug);
    if (slugs.length > 0) {
      return new Set(slugs);
    }
  }
  // Fallback for source runs where getRepoSkillsDir() returns undefined
  const moduleRelativeSkillsDir = join(
    import.meta.dir,
    "..",
    "..",
    "..",
    "skills",
  );
  const relativeSlugs = readLocalCategories(moduleRelativeSkillsDir).map(
    (c) => c.slug,
  );
  if (relativeSlugs.length > 0) {
    return new Set(relativeSlugs);
  }
  // Last resort: slugs from categories already fetched via the async/remote
  // path, so normalization still works once that cache is warm.
  return new Set(getCachedCategoriesSync().map((c) => c.slug));
}
