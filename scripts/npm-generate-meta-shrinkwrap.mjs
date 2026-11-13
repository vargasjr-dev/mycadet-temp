#!/usr/bin/env node
/**
 * Generate meta/npm-shrinkwrap.json WITHOUT npm's async publish queue in the
 * loop.
 *
 * The registry stores a published tarball immediately but only makes the new
 * version installable after the packument CDN refresh — measured at ~54
 * minutes for @mycadet/assistant@0.13.0-dev.202611131045.a556a8a (publish
 * 10:49Z, installable 11:43:33Z on run 127). The old flow polled
 * `npm install --package-lock-only` for up to 30 minutes waiting for the six
 * @mycadet/* versions to become resolvable and expired into ETARGET walls
 * whenever the queue ran slow.
 *
 * This flow resolves the six first-party packages from the tarballs the
 * publish jobs uploaded as artifacts (declared as `file:` deps, so npm
 * writes their lock entries from the tarballs' own package.json — no
 * registry metadata involved), then rewrites exactly those entries to their
 * canonical registry `resolved` URLs plus the sha512 integrity of the very
 * bytes that were published. Every transitive dependency resolves from the
 * registry normally: those are all previously-published, queue-free
 * versions.
 *
 * Usage: node scripts/npm-generate-meta-shrinkwrap.mjs <tarball-dir>
 *   <tarball-dir> holds the six published tarballs named by scopeless
 *   package name: app.tgz, assistant.tgz, cli.tgz, credential-executor.tgz,
 *   gateway.tgz, web.tgz. Reads meta/package.json (already version-stamped
 *   by stamp-dev-meta-package.sh) for the dependency versions.
 */

import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const repoRoot = join(import.meta.dirname, "..");
const metaDir = join(repoRoot, "meta");
const tarballDir = process.argv[2];

if (!tarballDir || !existsSync(tarballDir)) {
  console.error(`usage: node scripts/npm-generate-meta-shrinkwrap.mjs <tarball-dir>`);
  process.exit(1);
}

const meta = JSON.parse(readFileSync(join(metaDir, "package.json"), "utf8"));
const version = meta.version;
const firstPartyNames = Object.keys(meta.dependencies).filter((name) =>
  name.startsWith("@mycadet/"),
);
if (firstPartyNames.length === 0) {
  console.error("::error::meta/package.json declares no @mycadet/* dependencies");
  process.exit(1);
}

// Stage a build dir: the meta package with its first-party deps pointed at
// the local tarballs. Nothing here is published — the stage only exists so
// npm can resolve the full tree offline for the first-party slice.
const stage = join(metaDir, ".shrinkwrap-stage");
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, "tarballs"), { recursive: true });

const integrityByEntry = new Map(); // "@mycadet/assistant" -> sha512-… base64
for (const name of firstPartyNames) {
  const scopeless = name.split("/")[1];
  const tarball = join(tarballDir, `${scopeless}.tgz`);
  if (!existsSync(tarball)) {
    console.error(`::error::missing tarball for ${name}: expected ${tarball}`);
    process.exit(1);
  }
  cpSync(tarball, join(stage, "tarballs", `${scopeless}.tgz`));
  const integrity =
    "sha512-" + createHash("sha512").update(readFileSync(tarball)).digest("base64");
  integrityByEntry.set(name, integrity);
}

const stagedPackageJson = {
  ...meta,
  dependencies: Object.fromEntries(
    firstPartyNames.map((name) => [
      name,
      `file:tarballs/${name.split("/")[1]}.tgz`,
    ]),
  ),
};
// A staged package-lock.json would be resolved against the stage; drop any
// stale lock so npm resolves the tree fresh.
rmSync(join(stage, "package-lock.json"), { force: true });
rmSync(join(stage, "node_modules"), { recursive: true, force: true });
writeJson(join(stage, "package.json"), stagedPackageJson);

console.log("Resolving the dependency tree (first-party deps from local tarballs)…");
execFileSync(
  "npm",
  [
    "install",
    "--package-lock-only",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
  ],
  { cwd: stage, stdio: "inherit" },
);

const lock = JSON.parse(readFileSync(join(stage, "package-lock.json"), "utf8"));
const packages = lock.packages ?? {};

// The root entry must describe the PUBLISHED package.json — registry
// versions, not the staged file: specifiers.
packages[""] = {
  ...(packages[""] ?? {}),
  name: meta.name,
  version,
  dependencies: { ...meta.dependencies },
};

// Rewrite every @mycadet/* entry the tarballs produced (the root install and
// any nested dedupe) to its registry identity. Only entries whose version
// matches the stamped release are touched — a stale transitive pinch of an
// older @mycadet version, should one ever appear, keeps its own resolution.
const registryUrl = (name, entryVersion) =>
  `https://registry.npmjs.org/${name}/-/${name.split("/")[1]}-${entryVersion}.tgz`;

let rewritten = 0;
for (const [entryPath, entry] of Object.entries(packages)) {
  const name = firstPartyEntryName(entryPath);
  if (!name || entry.version !== version) {
    continue;
  }
  entry.resolved = registryUrl(name, entry.version);
  entry.integrity = integrityByEntry.get(name);
  delete entry.link;
  rewritten++;
}

if (rewritten < firstPartyNames.length) {
  console.error(
    `::error::only ${rewritten} of ${firstPartyNames.length} @mycadet/* entries were rewritten — npm did not resolve the staged tarballs as expected`,
  );
  process.exit(1);
}

// npm-shrinkwrap.json is a package-lock.json shipped inside the package:
// same shape, pinned intent.
writeJson(
  join(metaDir, "npm-shrinkwrap.json"),
  {
    name: meta.name,
    version,
    lockfileVersion: lock.lockfileVersion ?? 3,
    requires: true,
    packages,
  },
);

rmSync(stage, { recursive: true, force: true });
console.log(
  `npm-shrinkwrap.json generated off-registry: ${rewritten} @mycadet/* entries pinned to the published tarballs (v${version})`,
);

/** "@mycadet/cli" or "node_modules/@mycadet/cli" or a nested tail — undefined otherwise. */
function firstPartyEntryName(entryPath) {
  if (entryPath === "") {
    return undefined;
  }
  const segments = entryPath.split("node_modules/");
  const last = segments[segments.length - 1];
  return last.startsWith("@mycadet/") ? last : undefined;
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}
