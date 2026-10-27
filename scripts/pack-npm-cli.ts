#!/usr/bin/env bun
/**
 * Pack the @mycadet/cli npm tarball for a release channel.
 *
 * Shared by the dev and production publish jobs (dev-release.yaml's
 * `publish-npm-cli-dev`, release.yml's `publish-npm-cli-prod`), which
 * previously duplicated five shell steps. The steps, in order:
 *
 *   1. optionally stamp the CLI manifest with the release version
 *      (--version; the dev channel computes its version, the production
 *      channel trusts the release branch's bump and keeps the desync guard
 *      meaningful, so it omits this)
 *   2. stamp every bundled dependency's manifest with the release version
 *      so the installed copies classify the same environment the CLI does
 *      (the bundled @mycadet/local-mode reads its own package.json version)
 *   3. strip the bundled deps from the CLI manifest (bundled packages keep
 *      their names but lose registry-version specifiers — they ship inside
 *      the tarball's node_modules)
 *   4. optionally rename the bin for the channel (--bin; the dev channel
 *      installs `cadet-dev` so it never shadows the production `cadet`)
 *   5. `bun pm pack` into the output directory and rewrite the bundled
 *      deps in the packed manifest to file: specifiers
 *
 * The caller runs `bun install` first; the workspace must be installed for
 * `bun pm pack` to bundle the workspace deps.
 *
 * Usage:
 *   bun scripts/pack-npm-cli.ts --version <v> --out <dir> [--bin <name>]
 *   bun scripts/pack-npm-cli.ts --deps-version <v> --out <dir>
 */

import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const CLI_DIR = join(ROOT, "cli");

function die(message: string): never {
  console.error(`pack-npm-cli: ${message}`);
  process.exit(1);
}

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag.startsWith("--")) die(`unexpected argument "${flag}"`);
    const key = flag.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      die(`flag --${key} requires a value`);
    }
    args[key] = value;
    i++;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const version = args["version"];
const depsVersion = args["deps-version"] ?? version;
const binName = args["bin"];
const outDir = resolve(args["out"] ?? die("--out is required"));

if (!depsVersion) {
  die("one of --version or --deps-version is required");
}

interface Manifest {
  name: string;
  version: string;
  bin?: Record<string, string>;
  bundledDependencies?: string[];
  [key: string]: unknown;
}

function readManifest(path: string): Manifest {
  return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}

function writeManifest(path: string, manifest: Manifest): void {
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
}

function run(command: string, options: { cwd?: string } = {}): void {
  const result = spawnSync(command, {
    shell: true,
    cwd: options.cwd,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    die(`command failed: ${command}`);
  }
}

const cliManifestPath = join(CLI_DIR, "package.json");
const cliManifest = readManifest(cliManifestPath);

// 1. Stamp the CLI manifest (dev channel only — production's version comes
// from the release branch's bump, guarded in the workflow).
if (version) {
  cliManifest.version = version;
  writeManifest(cliManifestPath, cliManifest);
}

// 2. Stamp the bundled deps so their installed copies carry the channel.
// npm's official spelling — the workflows' pre-consolidation loops read
// `bundleDependencies`, which no manifest here sets, so their stamp step
// never actually stamped anything.
for (const name of cliManifest.bundledDependencies ?? []) {
  const manifestPath = join(
    ROOT,
    "packages",
    name.replace(/^@mycadet\//, ""),
    "package.json",
  );
  try {
    const manifest = readManifest(manifestPath);
    manifest.version = depsVersion;
    writeManifest(manifestPath, manifest);
  } catch {
    // Not every bundled name has a workspace directory; skip it.
  }
}

// 3. Strip the bundled deps from the manifest (shared with the assistant,
// credential-executor, and gateway publish jobs).
run(`bun scripts/strip-bundled-deps.mjs cli`, { cwd: ROOT });

// 4. Rename the bin for the channel (the original name is required so the
// rename can never accidentally publish a nameless bin).
if (binName) {
  const manifest = readManifest(cliManifestPath);
  const originalBin = manifest.bin?.cadet;
  if (!originalBin) {
    die("cannot rename the bin: the manifest has no 'cadet' bin");
  }
  manifest.bin = { [binName]: originalBin };
  writeManifest(cliManifestPath, manifest);
}

// 5. Pack the tarball and rewrite the bundled deps to file: specifiers.
mkdirSync(outDir, { recursive: true });
for (const stale of readdirSync(outDir).filter((f) => f.endsWith(".tgz"))) {
  rmSync(join(outDir, stale));
}
run(`bun pm pack --destination ${outDir}`, { cwd: CLI_DIR });
const packed = ((): string => {
  const candidates = readdirSync(outDir).filter((f) => f.endsWith(".tgz"));
  if (candidates.length !== 1) {
    die(`expected one packed tarball in ${outDir}, found ${candidates.length}`);
  }
  return join(outDir, candidates[0]!);
})();
const canonicalTarball = join(outDir, "package.tgz");
if (packed !== canonicalTarball) {
  renameSync(packed, canonicalTarball);
}
run(
  `bun scripts/strip-bundled-field-from-tarball.mjs ${canonicalTarball}`,
  { cwd: ROOT },
);

const publishedName = readManifest(cliManifestPath).name;
console.log(`packed ${publishedName} (${basename(canonicalTarball)}) into ${outDir}`);
