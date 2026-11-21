import { app } from "electron";
import path from "node:path";

import {
  BUNDLES_DIR_NAME,
  configureBundlePlatform,
} from "@mycadet/electron-desktop/bundle-platform";
import {
  handleBundleFile,
  installBundleFlow,
} from "@mycadet/electron-desktop/bundle-flow";
import { createBundleHostProvider } from "@mycadet/electron-desktop";
import { onFileOpen } from "@mycadet/electron-desktop/file-open";

import { getRendererBase } from "@mycadet/electron-desktop";
import { handle, on } from "@mycadet/electron-desktop/ipc";

export const install = (): void => {
  configureBundlePlatform({
    ...createBundleHostProvider(),
    bundlesRoot: () => path.join(app.getPath("userData"), BUNDLES_DIR_NAME),
    rendererBase: () => getRendererBase(app.isPackaged),
    ipc: { handle, on },
  });
  installBundleFlow();
  const stopFileOpen = onFileOpen((filePath) => {
    void handleBundleFile(filePath);
  });
  app.once("before-quit", stopFileOpen);
};
