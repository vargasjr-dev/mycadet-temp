import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import {
  buildBundledLocalPluginCatalogManifest,
  buildBundledPluginPackages,
} from "../../../assistant/scripts/bundled-plugin-packages.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A plugins/ tree with one valid fathom package. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "bundled-plugin-packages-"));
  roots.push(root);
  const packageRoot = join(root, "plugins", "mcp-catalog", "fathom");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "plugin.json"),
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "fathom",
      version: "1.0.0",
      description: "Search meeting transcripts.",
    }),
  );
  writeFileSync(
    join(packageRoot, "mcp.json"),
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: {
        fathom: {
          type: "streamable-http",
          url: "https://api.fathom.ai/mcp",
        },
      },
    }),
  );
  return root;
}

describe("buildBundledPluginPackages", () => {
  test("embeds a valid standard MCP package", () => {
    const packages = buildBundledPluginPackages(fixture());
    expect(packages["plugins/mcp-catalog/fathom"]).toMatchObject({
      version: "1.0.0",
      files: [
        { path: "mcp.json", contentBase64: expect.any(String) },
        { path: "plugin.json", contentBase64: expect.any(String) },
      ],
    });
  });

  test("rejects a directory whose manifest name does not match the directory", () => {
    const root = fixture();
    writeFileSync(
      join(root, "plugins", "mcp-catalog", "fathom", "plugin.json"),
      JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: "other",
        version: "1.0.0",
      }),
    );
    expect(() => buildBundledPluginPackages(root)).toThrow(
      /must match its manifest name/,
    );
  });

  test("skips a symlinked package directory (never followed)", () => {
    const root = fixture();
    symlinkSync(
      join(root, "plugins", "mcp-catalog", "fathom"),
      join(root, "plugins", "mcp-catalog", "fathom-link"),
    );
    const packages = buildBundledPluginPackages(root);
    expect(packages["plugins/mcp-catalog/fathom-link"]).toBeUndefined();
    expect(packages["plugins/mcp-catalog/fathom"]).toBeDefined();
  });

  test("rejects a symlinked mcp-catalog root that escapes plugins/", () => {
    const root = fixture();
    const outside = mkdtempSync(join(tmpdir(), "outside-plugins-"));
    roots.push(outside);
    // Copy the package content outside the repo, then point mcp-catalog at it.
    cpSync(join(root, "plugins", "mcp-catalog"), outside, { recursive: true });
    rmSync(join(root, "plugins", "mcp-catalog"), {
      recursive: true,
      force: true,
    });
    symlinkSync(outside, join(root, "plugins", "mcp-catalog"));
    expect(() => buildBundledPluginPackages(root)).toThrow(/escapes plugins\//);
  });

  test("rejects an invalid MCP server definition", () => {
    const root = fixture();
    writeFileSync(
      join(root, "plugins", "mcp-catalog", "fathom", "mcp.json"),
      JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        mcpServers: { fathom: { type: "streamable-http" } },
      }),
    );
    expect(() => buildBundledPluginPackages(root)).toThrow();
  });
});

describe("buildBundledLocalPluginCatalogManifest", () => {
  test("derives catalog entries from the plugin directories", () => {
    const root = fixture();
    writeFileSync(
      join(root, "plugins", "mcp-catalog", "fathom", "integration.json"),
      JSON.stringify({
        kind: "mcp",
        displayName: "Fathom",
        documentationUrl: "https://developers.fathom.ai/mcp-docs",
        verifiedAt: "2026-09-10",
        verification: "documentation-only",
        setup: { mode: "oauth", instructions: "Sign in." },
        logo: "fathom-mcp.png",
      }),
    );
    const entries = buildBundledLocalPluginCatalogManifest(root);
    expect(entries).toEqual([
      {
        name: "fathom",
        source: {
          source: "local",
          path: "plugins/mcp-catalog/fathom",
          version: "1.0.0",
        },
        description: "Search meeting transcripts.",
        integration: {
          kind: "mcp",
          displayName: "Fathom",
          documentationUrl: "https://developers.fathom.ai/mcp-docs",
          verifiedAt: "2026-09-10",
          verification: "documentation-only",
          setup: { mode: "oauth", instructions: "Sign in." },
          logo: "fathom-mcp.png",
        },
      },
    ]);
  });

  test("omits integration metadata when integration.json is absent", () => {
    const entries = buildBundledLocalPluginCatalogManifest(fixture());
    expect(entries[0]?.integration).toBeUndefined();
  });
});
