import { stat } from "node:fs/promises";

import { app, type Rectangle } from "electron";

import type { PermissionGuideInputs } from "./permission-guide";
import type { DraggablePermissionKind } from "@mycadet/ipc-contract";

import { defaultCaptureSourceDeps } from "./companion-capture-sources";
import { getMacHelperAppPath } from "../native-helper-client";
import { openPermissionSettingsPane } from "./permissions-strategy";
import { preparePermissionPresentation } from "./permissions";

/**
 * The surfaces only macOS has for the permission guide: the helper app
 * the user drags into System Settings, the pane opener, and the
 * settings-window list the guide follows.
 */
export const permissionGuide: PermissionGuideInputs = {
  async dragTarget() {
    const file = getMacHelperAppPath();
    // Resolve only app-owned paths in main; a renderer cannot choose a drag payload.
    const [fileStat, icon] = await Promise.all([
      stat(file),
      app.getFileIcon(file, { size: "normal" }),
    ]);
    if (!fileStat.isDirectory() || !file.endsWith(".app")) {
      throw new Error(
        "The permission app is unavailable. Reinstall Cadet and try again.",
      );
    }
    return { file, icon };
  },
  openSettingsPane: async (kind: DraggablePermissionKind) => {
    await openPermissionSettingsPane(kind);
  },
  listSettingsWindows: async (): Promise<
    Array<{ id?: number; bounds: Rectangle }>
  > =>
    (await defaultCaptureSourceDeps.listWindows())
      .filter((win) => win.bundleId === "com.apple.systempreferences")
      .map((win) => ({ id: win.windowId, bounds: win.bounds })),
  onYieldToSettings: preparePermissionPresentation,
};

/**
 * The guide's shell inputs, per OS: the macOS surfaces above where the OS
 * has a helper app to drag; nowhere else, so the guide doesn't install.
 */
export const permissionGuideInputs = (): PermissionGuideInputs | undefined =>
  process.platform === "darwin" ? permissionGuide : undefined;
