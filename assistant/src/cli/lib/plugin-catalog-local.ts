/**
 * Catalog for the default local plugins shipped inside the assistant
 * distribution, backed by a build-time-generated manifest.
 *
 * `bundled-local-plugins.json` is a generated artifact (git-ignored) that
 * `assistant/scripts/generate-bundled-plugin-packages.ts` derives from the
 * plugins' own directories (`plugin.json` + `integration.json` per plugin) —
 * the directories are the source of truth; there is no central catalog file.
 *
 * Only the LOCAL packages live here. The full installable catalog is Cadet
 * Cloud's (see {@link ./plugin-catalog-cache}); this manifest exists so
 * shipped integrations keep their metadata and offline materialization even
 * when the cloud catalog omits them.
 *
 * Importing the JSON directly (resolveJsonModule) inlines it into the bundle,
 * so there is no filesystem path resolution and the manifest is always
 * present at runtime — it works identically in dev, Docker, and an npm-packed
 * macOS install.
 */

import { z } from "zod";

import bundledManifest from "./bundled-local-plugins.json" with { type: "json" };
import { isPluginCatalogEntryVisible } from "./plugin-catalog-visibility.js";
import {
  localSourceSchema,
  mcpIntegrationSchema,
  PLUGIN_NAME_RE,
} from "./plugin-marketplace.js";
import {
  type PluginCatalog,
  projectMarketplaceEntries,
} from "./search-plugins.js";

// Re-exported so `local`-tagged CLI commands can gate on platform features
// without importing `platform/` directly (cli/no-daemon-internals allows lib).
export { areCloudFeaturesEnabled } from "../../cloud/feature-gate.js";
export { isPluginCatalogEntryVisible };

/** Schema for one entry of the generated bundled-local manifest. */
const bundledLocalEntrySchema = z.object({
  name: z.string().regex(PLUGIN_NAME_RE, "expected a kebab-case install name"),
  source: localSourceSchema,
  description: z.string().optional(),
  homepage: z.string().optional(),
  license: z.string().optional(),
  integration: mcpIntegrationSchema.optional(),
});

const bundledLocalManifestSchema = z.object({
  version: z.literal(1),
  plugins: z.array(bundledLocalEntrySchema),
});

let memoized: PluginCatalog | undefined;

/**
 * Validated generated manifest, parsed once and reused. A malformed
 * generated manifest is a build defect, so parsing throws rather than
 * silently degrading.
 */
function bundledEntries() {
  return bundledLocalManifestSchema.parse(bundledManifest).plugins;
}

/** Local packages the current assistant release can materialize itself. */
export function readBundledLocalPluginCatalog(): PluginCatalog {
  memoized ??= {
    ref: "bundled",
    matches: projectMarketplaceEntries(bundledEntries()),
  };
  return memoized;
}
