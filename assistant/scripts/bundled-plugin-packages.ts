import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";

import {
  AGENT_PLUGINS_MCP_SCHEMA_URL,
  SpecMcpDocumentSchema,
  SpecMcpServerSchema,
} from "../src/mcp/spec-schema.js";
import {
  readPluginManifest,
  STANDARD_PLUGIN_MANIFEST,
} from "../src/util/plugin-manifest.js";

export interface BundledPackageFile {
  path: string;
  contentBase64: string;
}

export interface BundledPackage {
  version: string;
  files: BundledPackageFile[];
}

export interface BundledLocalPluginEntry {
  name: string;
  source: { source: "local"; path: string; version: string };
  description?: string;
  homepage?: string;
  license?: string;
  integration?: Record<string, unknown>;
}

/**
 * Repo-root directory holding the default local plugins. Each child
 * directory with a standard plugin manifest is a plugin — the directory is
 * the source of truth; there is no central catalog file to maintain.
 */
const LOCAL_PLUGINS_DIR = join("plugins", "mcp-catalog");

interface DiscoveredPlugin {
  /** Plugin install name (must equal the directory and manifest name). */
  name: string;
  /** Canonical bundled-package path, e.g. `plugins/mcp-catalog/fathom`. */
  path: string;
  realpath: string;
  version: string;
  description?: string;
  homepage?: string;
  license?: string;
}

/**
 * Discover the default local plugins by scanning {@link LOCAL_PLUGINS_DIR}.
 * Directories without a standard plugin manifest are skipped; a directory
 * that declares one must be internally consistent (manifest name = directory
 * name). Symlinks anywhere in the path are rejected.
 */
function discoverLocalPlugins(repoRoot: string): DiscoveredPlugin[] {
  const scanRoot = join(repoRoot, LOCAL_PLUGINS_DIR);
  const scanRealpath = realpathSync(scanRoot);
  const pluginsRoot = realpathSync(join(repoRoot, "plugins"));
  const discovered: DiscoveredPlugin[] = [];

  for (const child of readdirSync(scanRealpath, { withFileTypes: true }).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    if (!child.isDirectory() || child.isSymbolicLink()) {
      continue;
    }
    const childPath = join(scanRealpath, child.name);
    if (lstatSync(childPath).isSymbolicLink()) {
      throw new Error(
        `local plugin directory may not be a symlink: ${LOCAL_PLUGINS_DIR}/${child.name}`,
      );
    }
    let pluginManifest: ReturnType<typeof readPluginManifest>;
    try {
      pluginManifest = readPluginManifest(childPath);
    } catch {
      // Directories without any plugin manifest are not plugins — skip them
      // (e.g. scratch or asset directories).
      continue;
    }
    if (pluginManifest.source !== STANDARD_PLUGIN_MANIFEST) {
      continue;
    }
    if (typeof pluginManifest.version !== "string") {
      throw new Error(
        `local plugin ${LOCAL_PLUGINS_DIR}/${child.name} has a manifest without a version`,
      );
    }
    if (pluginManifest.name !== child.name) {
      throw new Error(
        `local plugin directory ${child.name} must match its manifest name ${pluginManifest.name}`,
      );
    }
    const relativeToPlugins = relative(pluginsRoot, childPath);
    if (
      relativeToPlugins === "" ||
      relativeToPlugins === ".." ||
      relativeToPlugins.startsWith(`..${sep}`)
    ) {
      throw new Error(
        `local plugin escapes plugins/: ${LOCAL_PLUGINS_DIR}/${child.name}`,
      );
    }
    discovered.push({
      name: pluginManifest.name,
      path: `${LOCAL_PLUGINS_DIR.split(sep).join("/")}/${child.name}`,
      realpath: childPath,
      version: pluginManifest.version,
      description:
        typeof pluginManifest.description === "string"
          ? pluginManifest.description
          : undefined,
      homepage:
        typeof pluginManifest.homepage === "string"
          ? pluginManifest.homepage
          : undefined,
      license:
        typeof pluginManifest.license === "string"
          ? pluginManifest.license
          : undefined,
    });
  }
  return discovered;
}

/** Validate and embed every default local plugin under plugins/mcp-catalog. */
export function buildBundledPluginPackages(
  repoRoot: string,
): Record<string, BundledPackage> {
  const packages: Record<string, BundledPackage> = {};
  for (const discovered of discoverLocalPlugins(repoRoot)) {
    const { path, realpath: packageRealpath, version } = discovered;

    const rawMcp = JSON.parse(
      readFileSync(join(packageRealpath, "mcp.json"), "utf8"),
    ) as unknown;
    const mcp = SpecMcpDocumentSchema.parse(rawMcp);
    if (mcp.$schema !== AGENT_PLUGINS_MCP_SCHEMA_URL) {
      throw new Error(
        `local plugin ${path} must use the Agent Plugins MCP schema`,
      );
    }
    if (Object.keys(mcp.mcpServers).length === 0) {
      throw new Error(
        `local plugin ${path} must declare an MCP server`,
      );
    }
    for (const server of Object.values(mcp.mcpServers)) {
      SpecMcpServerSchema.parse(server);
    }

    const files: BundledPackageFile[] = [];
    const visit = (directory: string): void => {
      for (const child of readdirSync(directory, { withFileTypes: true })) {
        const childPath = join(directory, child.name);
        if (child.isSymbolicLink() || lstatSync(childPath).isSymbolicLink()) {
          throw new Error(
            `local plugin packages may not contain symlinks: ${path}/${child.name}`,
          );
        }
        if (child.isDirectory()) {
          visit(childPath);
          continue;
        }
        if (!child.isFile()) {
          throw new Error(
            `local plugin package contains an unsupported entry: ${childPath}`,
          );
        }
        files.push({
          path: relative(packageRealpath, childPath).split(sep).join("/"),
          contentBase64: readFileSync(childPath).toString("base64"),
        });
      }
    };
    visit(packageRealpath);
    files.sort((a, b) => a.path.localeCompare(b.path));
    if (packages[path]) {
      throw new Error(`duplicate local plugin package: ${path}`);
    }
    packages[path] = { version, files };
  }
  return packages;
}

/**
 * Build the generated local-plugin catalog manifest: one entry per
 * discovered plugin, with its metadata from the plugin manifest and its
 * integration metadata from the sibling `integration.json` (when present).
 * This is what the CLI merges into the cloud catalog; the directories are
 * the source of truth.
 */
export function buildBundledLocalPluginCatalogManifest(
  repoRoot: string,
): BundledLocalPluginEntry[] {
  const entries: BundledLocalPluginEntry[] = [];
  for (const discovered of discoverLocalPlugins(repoRoot)) {
    const { path, version, name } = discovered;
    const entry: BundledLocalPluginEntry = {
      name,
      source: { source: "local", path, version },
    };
    if (discovered.description !== undefined) {
      entry.description = discovered.description;
    }
    if (discovered.homepage !== undefined) {
      entry.homepage = discovered.homepage;
    }
    if (discovered.license !== undefined) {
      entry.license = discovered.license;
    }
    const integrationPath = join(discovered.realpath, "integration.json");
    try {
      entry.integration = JSON.parse(readFileSync(integrationPath, "utf8")) as
        Record<string, unknown>;
    } catch {
      // integration.json is optional; a missing or unreadable file simply
      // means the plugin ships without integration metadata.
    }
    entries.push(entry);
  }
  return entries;
}
