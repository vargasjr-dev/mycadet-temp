import { app } from "electron";
import path from "node:path";

import { BUNDLES_DIR_NAME, configureBundlePlatform } from "../bundle-platform";
import { handleBundleFile, installBundleFlow } from "../bundle-flow";
import { createBundleHostProvider } from "../bundle-host";
import { onFileOpen } from "../file-open";

import { getRendererBase } from "../app-config";

export const install = (): void => {
  configureBundlePlatform({
    ...createBundleHostProvider(),
    bundlesRoot: () => path.join(app.getPath("userData"), BUNDLES_DIR_NAME),
    rendererBase: () => getRendererBase(app.isPackaged),
  });
  installBundleFlow();
  const stopFileOpen = onFileOpen((filePath) => {
    void handleBundleFile(filePath);
  });
  app.once("before-quit", stopFileOpen);
};
