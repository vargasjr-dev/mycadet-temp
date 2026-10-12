/**
 * Platform detection and environment-shaping helpers.
 *
 * Directory-layout helpers (every canonical path under the workspace and
 * its data dir) live in `util/layout.ts` — they were never platform
 * concerns. This module re-exports that module for backward compatibility;
 * new code should import layout helpers from `./layout.js` directly.
 */

import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export * from "./layout.js";

export function isMacOS(): boolean {
  return process.platform === "darwin";
}

export function isLinux(): boolean {
  return process.platform === "linux";
}

export function isWindows(): boolean {
  return process.platform === "win32";
}

/**
 * Per-user application data root: `~/Library/Application Support` on macOS,
 * `%APPDATA%` on Windows, `$XDG_DATA_HOME` (default `~/.local/share`) elsewhere.
 */
export function getUserAppDataDir(): string {
  if (isMacOS()) {
    return join(homedir(), "Library", "Application Support");
  }
  if (isWindows()) {
    return process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  }
  return process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
}

/**
 * Extra directories to prepend to PATH so daemon-spawned tools are found
 * even when launched from a minimal environment (macOS .app bundle). Empty
 * on Windows, where PATH already carries the installer-managed entries.
 */
export function getExtraToolPathDirs(): string[] {
  if (isWindows()) {
    return [];
  }
  return [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(homedir(), ".local", "bin"),
  ];
}

/**
 * Add missing `dirs` to the PATH entry of `env` in place, using the cloud
 * delimiter. Windows keys the variable as `Path`, so the existing key is
 * matched case-insensitively rather than assuming `PATH`.
 */
export function addToPathEnv(
  env: Record<string, string | undefined>,
  dirs: string[],
  position: "front" | "back" = "front",
): void {
  if (dirs.length === 0) {
    return;
  }
  const key =
    Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const entries = (env[key] ?? "").split(delimiter).filter(Boolean);
  const missing = dirs.filter((d) => !entries.includes(d));
  if (missing.length === 0) {
    return;
  }
  env[key] =
    position === "front"
      ? [...missing, ...entries].join(delimiter)
      : [...entries, ...missing].join(delimiter);
}

/**
 * Returns the raw platform string from Node.js (e.g. 'darwin', 'linux', 'win32').
 * Prefer this over accessing process.platform directly so all platform
 * detection is routed through this module.
 */
export function getPlatformName(): string {
  return process.platform;
}

/**
 * Normalize an assistant ID to its canonical form for DB operations.
 *
 * The system uses "self" as the canonical single-tenant identifier
 * (see migration 007-assistant-id-to-self). However, the desktop UI
 * sends the real assistant ID (e.g., "cadet-true-eel") while the
 * inbound call path resolves phone numbers to config keys (typically
 * "self"). This function maps the current assistant's ID to "self"
 * so both sides use a consistent DB key.
 */
export function normalizeAssistantId(assistantId: string): string {
  if (assistantId === "self") {
    return "self";
  }

  const ownName = process.env.CADET_ASSISTANT_NAME;
  if (ownName && assistantId === ownName) {
    return "self";
  }

  return assistantId;
}
