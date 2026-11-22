import { stat } from "node:fs/promises";

import { app, type Rectangle } from "electron";


import { defaultCaptureSourceDeps } from "./companion-capture-sources";
import { getMacHelperAppPath } from "../native-helper-client";

export async function dragTarget() {
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
}

export async function listSettingsWindows(): Promise<
  Array<{ id?: number; bounds: Rectangle }>
> {
  return (await defaultCaptureSourceDeps.listWindows())
    .filter((win) => win.bundleId === "com.apple.systempreferences")
    .map((win) => ({ id: win.windowId, bounds: win.bounds }));
}
