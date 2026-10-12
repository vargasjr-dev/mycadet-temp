#!/usr/bin/env bun

import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  buildBundledLocalPluginCatalogManifest,
  buildBundledPluginPackages,
} from "./bundled-plugin-packages.js";

const repoRoot = resolve(import.meta.dir, "../..");
const packages = {
  version: 1,
  packages: buildBundledPluginPackages(repoRoot),
};
const localCatalog = {
  version: 1,
  plugins: buildBundledLocalPluginCatalogManifest(repoRoot),
};

if (process.argv.includes("--check")) {
  console.log("✓ Local plugin packages and catalog manifest are valid");
} else {
  writeFileSync(
    join(
      repoRoot,
      "assistant",
      "src",
      "cli",
      "lib",
      "bundled-plugin-packages.json",
    ),
    `${JSON.stringify(packages, null, 2)}\n`,
  );
  writeFileSync(
    join(
      repoRoot,
      "assistant",
      "src",
      "cli",
      "lib",
      "bundled-local-plugins.json",
    ),
    `${JSON.stringify(localCatalog, null, 2)}\n`,
  );
  console.log("✓ Generated bundled local plugin packages + catalog manifest");
}
