import { app } from "electron";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { NativeSidecarClient } from "@mycadet/native-sidecar/supervisor";

import log from "./app-logger";

/**
 * The native helper sidecar client, one per process. macOS ships the helper
 * as a signed .app bundle (its Accessibility and Screen Recording grants are
 * the helper's own); Windows ships a real helper binary (recognized speech,
 * permissions, toasts); Linux has no helper yet, so its client fails closed
 * and the capability modules report unavailable. All three shapes are the
 * same `NativeSidecarClient`, differing only in where the executable
 * resolves.
 */

/**
 * The mac helper bundle's folder name is per-environment (e.g. "Cadet
 * Helper", "Cadet Helper Dev"). macOS System Settings → Privacy & Security
 * renders the .app folder name — not CFBundleName/CFBundleDisplayName, and
 * not the binary's filename — when listing the helper's grants, so the
 * runtime resolves the folder from the sidecar that build-mac-helper.sh
 * writes alongside the bundle (`.cadet-mac-helper.bundle-name`).
 *
 * When the sidecar is absent, discovery walks `<bin>/` for any `.app` folder
 * whose Info.plist matches the expected CFBundleExecutable, then falls back
 * to `cadet-mac-helper.app`.
 */
const SIDECAR_NAME = ".cadet-mac-helper.bundle-name";
const DEFAULT_HELPER_BUNDLE_NAME = "cadet-mac-helper";
const DEFAULT_HELPER_EXECUTABLE = "cadet-mac-helper";

const readSidecarBundleName = (binDir: string): string | null => {
  const sidecarPath = path.join(binDir, SIDECAR_NAME);
  if (!existsSync(sidecarPath)) return null;
  try {
    const value = readFileSync(sidecarPath, "utf8").trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
};

/**
 * Walks the bin directory to find the .app folder whose Info.plist's
 * CFBundleExecutable matches the executable name. Used as a fallback when
 * the sidecar is missing — gives the path resolution a way to discover a
 * bundle by its binary rather than its folder name.
 */
const resolveHelperBundleNameFromExecutable = (
  binDir: string,
  executableName: string,
): string | null => {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(binDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith(".app")) continue;
    const infoPlist = path.join(binDir, entry.name, "Contents", "Info.plist");
    if (!existsSync(infoPlist)) continue;
    try {
      const match = readFileSync(infoPlist, "utf8").match(
        /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/,
      );
      if (match?.[1]?.trim() === executableName) {
        return entry.name.replace(/\.app$/, "");
      }
    } catch {
      // Skip unreadable plists and keep looking.
    }
  }
  return null;
};

const resolveHelperBundleName = (binDir: string): string => {
  const sidecar = readSidecarBundleName(binDir);
  if (sidecar) return sidecar;

  // No sidecar: enumerate `<bin>/` for an `.app` folder whose
  // CFBundleExecutable matches the expected name. When there's no `.app`
  // folder at all, the consumer surfaces "helper is not available" via its
  // existing missing-bundle guard.
  const discovered = resolveHelperBundleNameFromExecutable(
    binDir,
    DEFAULT_HELPER_EXECUTABLE,
  );
  return discovered ?? DEFAULT_HELPER_BUNDLE_NAME;
};

const resolveHelperExecutableName = (appPath: string): string => {
  try {
    const infoPlist = readFileSync(
      path.join(appPath, "Contents", "Info.plist"),
      "utf8",
    );
    const match = infoPlist.match(
      /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/,
    );
    return match?.[1]?.trim() || DEFAULT_HELPER_EXECUTABLE;
  } catch {
    return DEFAULT_HELPER_EXECUTABLE;
  }
};

export const getMacHelperAppPath = (): string => {
  const binDir = app.isPackaged
    ? path.join(process.resourcesPath, "bin")
    : path.join(app.getAppPath(), "resources");

  return path.join(binDir, `${resolveHelperBundleName(binDir)}.app`);
};

export const getMacHelperPath = (): string => {
  const appPath = getMacHelperAppPath();
  return path.join(
    appPath,
    "Contents",
    "MacOS",
    resolveHelperExecutableName(appPath),
  );
};

/** Published by scripts/build-native-helper.ts under resources/native-helper. */
export const getWindowsHelperPath = (): string => {
  const root = app.isPackaged
    ? process.resourcesPath
    : path.join(app.getAppPath(), "resources");
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return path.join(root, "native-helper", arch, "Cadet.WindowsHelper.exe");
};

/** Placeholder: no Linux helper binary exists yet, so every RPC fails closed. */
export const getLinuxHelperPath = (): string =>
  "/nonexistent/cadet-linux-helper";

export const getSharedHelperPath = (): string => {
  if (process.platform === "darwin") return getMacHelperPath();
  if (process.platform === "win32") return getWindowsHelperPath();
  return getLinuxHelperPath();
};

let client: NativeSidecarClient | null = null;

export const getSharedHelperClient = (): NativeSidecarClient =>
  (client ??= new NativeSidecarClient({
    resolveExecutablePath: getSharedHelperPath,
    logger: log,
  }));

/**
 * Test seam: drop the shared client so the next call spawns a fresh one. A
 * supervised helper left running keeps its respawn timers — a later test's
 * writes land on the wrong child. Settle it before dropping it.
 */
export const resetSharedHelperClient = (): void => {
  try {
    client?.shutdown();
  } catch {
    // The client was already gone.
  }
  client = null;
};
