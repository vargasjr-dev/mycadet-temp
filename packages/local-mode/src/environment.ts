import { existsSync, readFileSync } from "node:fs";

import {
  isDevVersion,
  isLocalVersion,
  isStagingVersion,
} from "@mycadet/shared/version";

import { dirname, join, resolve } from "node:path";

import {
  joinLocalPath,
  resolveConfigHomes,
  type LocalPathOptions,
} from "./paths";

const PRODUCTION_ENVIRONMENT_NAME = "production";

/**
 * Location of the persisted default-environment file. Read to honor
 * defaults persisted by older CLIs. It lives at a fixed,
 * environment-agnostic path so it can be read before the environment is
 * known. Uses AppData on Windows and the XDG config home on macOS and
 * Linux.
 */
export function defaultEnvironmentFilePaths(
  env: Record<string, string | undefined>,
  options: LocalPathOptions = {},
): string[] {
  return resolveConfigHomes(env, options).map((home) =>
    joinLocalPath(options, home, "cadet", "environment"),
  );
}

export function defaultEnvironmentFilePath(
  env: Record<string, string | undefined>,
  options: LocalPathOptions = {},
): string {
  return defaultEnvironmentFilePaths(env, options)[0]!;
}

/**
 * Read the persisted default environment name, or `undefined` when no default
 * has been set (no file, empty file, or unreadable).
 */
export function readDefaultEnvironment(
  env: Record<string, string | undefined>,
  options: LocalPathOptions = {},
): string | undefined {
  for (const filePath of defaultEnvironmentFilePaths(env, options)) {
    try {
      if (!existsSync(filePath)) {
        continue;
      }
      const content = readFileSync(filePath, "utf-8").trim();
      if (content.length > 0) {
        return content;
      }
    } catch {
      // Try the next compatible location.
    }
  }
  return undefined;
}

/**
 * The version of the package the user invoked, or `undefined` when nothing
 * nearby declares one — the Electron and OS-client hosts bundle local-mode
 * without a channel-carrying package.
 *
 * The CLI carries its release channel in its own version (`-dev.`,
 * `-staging.`, plain for production) — the same field the CLI's own
 * environment resolver reads from its package.json. local-mode finds that
 * package by walking up from the invoked entry script rather than by
 * importing it: an installed run enters through the `mycadet` meta-package's
 * bin shim, whose package.json is stamped with the same release version as
 * `@mycadet/cli`, and a source checkout enters through `cli/src`, whose
 * package.json is plain. The walk uses only node builtins so bundler hosts
 * that inline this source-only package never see a foreign specifier.
 */
function invokedPackageVersion(
  entryPath: string | undefined,
): string | undefined {
  if (!entryPath) return undefined;
  let dir = dirname(resolve(entryPath));
  for (let depth = 0; depth < 8; depth++) {
    try {
      const pkg = JSON.parse(
        readFileSync(join(dir, "package.json"), "utf-8"),
      ) as { version?: string };
      if (typeof pkg.version === "string" && pkg.version.length > 0) {
        return pkg.version;
      }
    } catch {
      // No package.json at this level; keep walking.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * The environment a released channel version pins, or `undefined` when the
 * version carries no channel suffix. A plain version — a source checkout's
 * package.json — reads as "no version signal", leaving the remaining steps
 * to decide. Mirrors the CLI resolver's mapping (local, dev, staging).
 */
export function environmentFromVersion(version: string): string | undefined {
  if (isLocalVersion(version)) return "local";
  if (isDevVersion(version)) return "dev";
  if (isStagingVersion(version)) return "staging";
  return undefined;
}

/**
 * Resolve the active environment name from a single source of truth so every
 * local-mode host — the CLI `client` server, the web app's Vite dev
 * middleware, and the Electron main process — reads and writes the same
 * lockfile and config directory.
 *
 * Resolution order:
 *   1. `CADET_ENVIRONMENT` (explicit override, also inherited by the
 *      hatch/retire child processes the CLI spawns)
 *   2. the release channel stamped into the CLI package's own version —
 *      a released `-dev.` install resolves `dev` even on a machine that
 *      never wrote a persisted default
 *   3. the persisted default written by pre-version-tied CLIs
 *      (old files are still honored)
 *   4. `production`
 *
 * The version step is what keeps every released install from silently
 * reading production's state: the channel is decided by the release
 * pipeline, not by whatever default an older CLI happened to leave behind.
 * Resolving the persisted default here — rather than only inspecting
 * `CADET_ENVIRONMENT` — is what keeps a host with no CLI package (the
 * Electron main) pointed at the same environment the CLI uses.
 */
export function resolveEnvironmentName(): string {
  const version = invokedPackageVersion(process.argv[1]);
  return (
    process.env.CADET_ENVIRONMENT?.trim() ||
    (version !== undefined ? environmentFromVersion(version) : undefined) ||
    readDefaultEnvironment(process.env) ||
    PRODUCTION_ENVIRONMENT_NAME
  );
}
