import { existsSync, readFileSync } from "node:fs";

import {
  isDevVersion,
  isLocalVersion,
  isStagingVersion,
} from "@mycadet/shared/version";

import { joinLocalPath, resolveConfigHomes } from "./paths";

// The package's own version. Workspace checkouts read 0.0.1; the release
// pipeline stamps every bundled package with the release version when it
// packs the CLI tarball, so an installed copy carries the same channel stamp
// as @mycadet/cli.
import { version as packageVersion } from "../package.json";

const PRODUCTION_ENVIRONMENT_NAME = "production";

/**
 * Location of the persisted default-environment file. Read to honor
 * defaults persisted by older CLIs. It lives at a fixed,
 * environment-agnostic path so it can be read before the environment is
 * known. Uses AppData on Windows and the XDG config home on macOS and
 * Linux.
 */
export function defaultEnvironmentFilePaths(): string[] {
  return resolveConfigHomes().map((home) =>
    joinLocalPath(home, "cadet", "environment"),
  );
}

export function defaultEnvironmentFilePath(): string {
  return defaultEnvironmentFilePaths()[0]!;
}

/**
 * Read the persisted default environment name, or `undefined` when no default
 * has been set (no file, empty file, or unreadable).
 */
export function readDefaultEnvironment(): string | undefined {
  for (const filePath of defaultEnvironmentFilePaths()) {
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
 * The environment a released channel version pins, or `undefined` when the
 * version carries no channel suffix. A plain version — a workspace
 * checkout's 0.0.1 — reads as "no version signal", leaving the remaining
 * steps to decide. Mirrors the CLI resolver's mapping (local, dev, staging).
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
 *   2. the release channel stamped into this package's own version —
 *      a released `-dev.` install resolves `dev` even on a machine that
 *      never wrote a persisted default
 *   3. the persisted default written by pre-version-tied CLIs
 *      (old files are still honored)
 *   4. `production`
 *
 * The version step is what keeps every released install from silently
 * reading production's state: the channel is decided by the release
 * pipeline, not by whatever default an older CLI happened to leave behind.
 * Reading the package's own version (rather than climbing to the CLI's) is
 * what keeps hosts that bundle local-mode without the CLI — the Electron
 * main, the OS clients — safe: their builds inline the workspace 0.0.1,
 * which pins nothing.
 */
export function resolveEnvironmentName(): string {
  return (
    process.env.CADET_ENVIRONMENT?.trim() ||
    environmentFromVersion(packageVersion) ||
    readDefaultEnvironment() ||
    PRODUCTION_ENVIRONMENT_NAME
  );
}
