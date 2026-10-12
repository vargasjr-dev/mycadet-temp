import { describe, expect, test } from "bun:test";

import {
  filterPluginCatalogByFeatureFlags,
  MCP_CATALOG_QA_INTEGRATIONS_FLAG,
} from "../plugin-catalog-visibility.js";
import type { PluginCatalog, PluginSearchMatch } from "../search-plugins.js";

const SHA = "0".repeat(40);

function match(name: string): PluginSearchMatch {
  return {
    name,
    path: `github:acme/${name}@${SHA}`,
    category: null,
    source: { kind: "github", repo: `acme/${name}`, ref: SHA },
  };
}

function catalog(names: string[]): PluginCatalog {
  return { ref: "main", matches: names.map(match) };
}

describe("filterPluginCatalogByFeatureFlags", () => {
  test("hides QA integrations while the flag is off", () => {
    const input = catalog([
      "fathom",
      "gamma",
      "guru",
      "intercom",
      "ramp",
      "semrush",
      "typeform",
      "upwork",
      "notion",
    ]);

    const result = filterPluginCatalogByFeatureFlags(input, (key) => {
      expect(key).toBe(MCP_CATALOG_QA_INTEGRATIONS_FLAG);
      return false;
    });

    expect(result.matches.map((entry) => entry.name)).toEqual([
      "fathom",
      "notion",
    ]);
  });

  test("returns the full catalog while the flag is on", () => {
    const input = catalog([
      "fathom",
      "gamma",
      "guru",
      "intercom",
      "ramp",
      "semrush",
      "typeform",
      "upwork",
    ]);

    const result = filterPluginCatalogByFeatureFlags(input, () => true);

    expect(result).toBe(input);
  });
});
