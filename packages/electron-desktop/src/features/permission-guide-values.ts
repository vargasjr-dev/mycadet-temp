import { stat } from "node:fs/promises";

import { app, type Rectangle, type NativeImage } from "electron";

import type { DraggablePermissionKind } from "@mycadet/ipc-contract";

import { defaultCaptureSourceDeps } from "./companion-capture-sources";
import { getMacHelperAppPath } from "../native-helper-client";
import { openPermissionSettingsPane } from "./permissions-strategy";

/**
 * The helper app to drag into the list, with its icon: resolved only in
 * main, since a renderer cannot choose a drag payload.
 */
export const dragTarget = async (): Promise<{
  file: string;
  icon: NativeImage;
}> => {
  const file = getMacHelperAppPath();
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
};

export const openSettingsPane = async (
  kind: DraggablePermissionKind,
): Promise<void> => {
  await openPermissionSettingsPane(kind);
};

/** The OS settings windows, when the OS can name them. */
export const listSettingsWindows = async (): Promise<
  Array<{ id?: number; bounds: Rectangle }>
> =>
  (await defaultCaptureSourceDeps.listWindows())
    .filter((win) => win.bundleId === "com.apple.systempreferences")
    .map((win) => ({ id: win.windowId, bounds: win.bounds }));
