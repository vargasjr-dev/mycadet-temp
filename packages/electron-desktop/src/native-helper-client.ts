import { app } from "electron";
import path from "node:path";

import { NativeSidecarClient } from "@mycadet/native-sidecar/supervisor";

import log from "./app-logger";

/**
 * The native helper sidecar client, one per process. Windows ships a real
 * helper binary (recognized speech, permissions, toasts); Linux has no
 * helper yet, so its client fails closed and the capability modules report
 * unavailable. Both shapes are the same `NativeSidecarClient`, differing
 * only in where the executable resolves.
 */

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

export const getSharedHelperPath = (): string =>
  process.platform === "win32" ? getWindowsHelperPath() : getLinuxHelperPath();

let client: NativeSidecarClient | null = null;

export const getSharedHelperClient = (): NativeSidecarClient =>
  (client ??= new NativeSidecarClient({
    name: "native helper",
    resolveExecutablePath: getSharedHelperPath,
    logger: log,
    platform: process.platform,
  }));

/** Test seam: drop the shared client so the next call spawns a fresh one. */
export const resetSharedHelperClient = (): void => {
  client = null;
};
