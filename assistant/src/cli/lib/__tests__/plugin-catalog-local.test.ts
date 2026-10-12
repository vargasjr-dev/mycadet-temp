/**
 * Tests for the default local-plugin catalog reader.
 *
 * The catalog is projected from the manifest generated at build time from the
 * plugins' own directories — no network, no central catalog file.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { buildBundledLocalPluginCatalogManifest } from "../../../../scripts/bundled-plugin-packages.js";
import bundledManifest from "../bundled-local-plugins.json" with { type: "json" };
import { readBundledLocalPluginCatalog } from "../plugin-catalog-local.js";

const LOCAL_PLUGINS_DIR = join(
  import.meta.dir,
  "../../../../../plugins/mcp-catalog",
);

/** Every directory under plugins/mcp-catalog that ships a plugin manifest. */
function onDiskPluginDirs(): string[] {
  return readdirSync(LOCAL_PLUGINS_DIR, { withFileTypes: true })
    .filter((child) => child.isDirectory())
    .map((child) => child.name)
    .sort((a, b) => a.localeCompare(b));
}

describe("readBundledLocalPluginCatalog", () => {
  test("yields one match per on-disk local plugin, sorted alphabetically", () => {
    const catalog = readBundledLocalPluginCatalog();

    expect(catalog.ref).toBe("bundled");
    expect(catalog.matches.map((m) => m.name)).toEqual(onDiskPluginDirs());

    const names = catalog.matches.map((m) => m.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(new Set(names).size).toBe(names.length);
  });

  test("every match resolves to a bundled local package under plugins/mcp-catalog", () => {
    const catalog = readBundledLocalPluginCatalog();

    for (const match of catalog.matches) {
      expect(match.source.kind).toBe("local");
      if (match.source.kind !== "local") {
        continue;
      }
      expect(match.source.path.startsWith("plugins/mcp-catalog/")).toBe(true);
    }
  });

  test("projects the generated manifest's metadata onto the match shape", () => {
    const catalog = readBundledLocalPluginCatalog();
    const match = catalog.matches.find((m) => m.name === "fathom");

    expect(match).toMatchObject({
      name: "fathom",
      description: "Search meeting transcripts and summaries.",
      homepage: "https://developers.fathom.ai/mcp-docs",
      license: "MIT",
      integration: {
        kind: "mcp",
        displayName: "Fathom",
        category: "meetings",
        logo: "fathom-mcp.png",
      },
    });
    if (match?.source.kind !== "local") {
      throw new Error("expected local source");
    }
    expect(match.source.path).toBe("plugins/mcp-catalog/fathom");
    expect(match.source.version).toBe("1.0.2");
  });

  test("the committed generated manifest matches a fresh directory scan", () => {
    const fresh = buildBundledLocalPluginCatalogManifest(
      join(import.meta.dir, "../../../../.."),
    );
    // The JSON import widens the literal types (source.source: string), so the
    // structural comparison needs the narrowed view.
    expect(fresh).toEqual(bundledManifest.plugins as typeof fresh);
  });
});
