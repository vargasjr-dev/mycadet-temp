import { app } from "electron";
import path from "node:path";

import { createBundleHostProvider } from "@mycadet/electron-desktop/bundle-host";
import {
  handleBundleFile,
  installBundleFlow,
} from "@mycadet/electron-desktop/bundle-flow";
import type {
  CapabilityModule,
  DesktopCapabilityRegistry,
} from "@mycadet/electron-desktop/capability-registry";
import {
  BUNDLES_DIR_NAME,
  bundleFileHandlerToken,
  configureBundlePlatform,
} from "@mycadet/electron-desktop/bundle-platform";
import { onFileOpen } from "@mycadet/electron-desktop/file-open";

import { getRendererBase } from "../app-config";
import { handle, on } from "../ipc.client";

const bundles: CapabilityModule<DesktopCapabilityRegistry> = {
  id: "windows.bundles",
  install(registry) {
    configureBundlePlatform({
      ...createBundleHostProvider(),
      bundlesRoot: () => path.join(app.getPath("userData"), BUNDLES_DIR_NAME),
      rendererBase: () => getRendererBase(app.isPackaged),
      ipc: { handle, on },
    });
    installBundleFlow();
    registry.provide(bundleFileHandlerToken, handleBundleFile);
    const stopFileOpen = onFileOpen((filePath) => {
      void handleBundleFile(filePath);
    });
    app.once("before-quit", stopFileOpen);
  },
};

export default bundles;
