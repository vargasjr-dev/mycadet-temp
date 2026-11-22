/**
 * Loader for the native capture-sources addon
 * (`native/capture-sources`, built by
 * `scripts/build-capture-sources.sh`).
 *
 * The addon is the helper's `captureSources.list` ported in-process: one
 * synchronous `CGWindowListCopyWindowInfo` call that answers the Teach
 * picker's window list — bounds, owner, title — without the helper process
 * and its JsonRpc hop. Like the notifier loader, the addon is an optional
 * resource: a checkout that never ran the build script, a non-mac host, or a
 * build for another architecture simply has no `.node` file, and a load or
 * call failure reports unavailable so the caller falls back to the helper.
 */

import { app } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";

import log from "../app-logger";
import type { HelperWindow } from "./companion-capture-sources";

const ADDON_FILENAME = "cadet-capture-sources.node";

/**
 * Kill switch for a build where the addon misbehaves: the loader reports
 * unavailable and the window list goes back through the helper.
 */
const DISABLE_ENV_VAR = "CADET_DISABLE_NATIVE_CAPTURE_SOURCES";

/**
 * The addon's one export: the helper's `captureSources.list` envelope,
 * `{ windows: [...] }`, synchronously. Undefined (never a throw) when the
 * addon's own answer failed.
 */
export type NativeWindowLister = (
  includeOffscreen?: boolean,
) => { windows: unknown[] } | undefined;

const resolveAddonPath = (): string => {
  const base = app.isPackaged
    ? path.join(process.resourcesPath, "bin", "capture-sources")
    : path.join(app.getAppPath(), "resources", "capture-sources");
  return path.join(base, process.arch, ADDON_FILENAME);
};

// `undefined` means "not attempted yet"; `null` means "attempted, unavailable".
let cached: NativeWindowLister | null | undefined;

/** The addon's contract is one method; callability is the load-bearing check. */
const isWindowLister = (value: unknown): value is NativeWindowLister =>
  typeof value === "function";

/**
 * The addon's raw rows, as the helper's JsonRpc answer arrived — validated at
 * the same boundary (`parseHelperWindows`) whichever lister produced them.
 */
export const loadNativeWindowLister = (): NativeWindowLister | null => {
  if (cached !== undefined) {
    return cached;
  }
  cached = null;
  if (process.env[DISABLE_ENV_VAR] === "1") {
    log.info(`[capture-sources] ${DISABLE_ENV_VAR}=1; using the helper`);
    return cached;
  }
  const addonPath = resolveAddonPath();
  if (!existsSync(addonPath)) {
    log.info(`[capture-sources] no addon at ${addonPath}; using the helper`);
    return cached;
  }
  try {
    const addon: { exports: unknown } = { exports: {} };
    process.dlopen(addon, addonPath);
    const exports: unknown = addon.exports;
    if (
      typeof exports === "object" &&
      exports !== null &&
      "list" in exports &&
      isWindowLister(exports.list)
    ) {
      cached = exports.list;
    } else {
      log.warn("[capture-sources] addon is missing the expected `list` export");
    }
  } catch (error) {
    log.warn("[capture-sources] failed to load addon:", error);
  }
  return cached;
};

/**
 * The window list from the addon, or null when the addon is unavailable or
 * its answer failed — the caller's cue to fall back to the helper. The rows
 * are the helper's own shape and arrive in the same front-to-back order, so
 * the boundary check and every consumer stay unchanged.
 */
export const listWindowsWithAddon = async (
  includeOffscreen = false,
): Promise<HelperWindow[] | null> => {
  const list = loadNativeWindowLister();
  if (!list) {
    return null;
  }
  try {
    const answer = list(includeOffscreen);
    if (!answer || !Array.isArray(answer.windows)) {
      return null;
    }
    // The rows are the helper's shape, validated at the same boundary
    // (`parseHelperWindows`) whichever lister produced them; the array's
    // elements ride as the caller validates them.
    return answer.windows.filter(
      (row): row is HelperWindow => typeof row === "object" && row !== null,
    );
  } catch (error) {
    log.warn("[capture-sources] addon list failed; using the helper:", error);
    return null;
  }
};

export const __resetForTesting = (): void => {
  cached = undefined;
};
