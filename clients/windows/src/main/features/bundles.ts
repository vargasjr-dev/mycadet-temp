import { app } from "electron";
import path from "node:path";

import {
  BUNDLES_DIR_NAME,
  bundleFileHandlerToken,
  configureBundlePlatform,
} from "@mycadet/electron-desktop/bundle-platform";
import {
  handleBundleFile,
  installBundleFlow,
} from "@mycadet/electron-desktop/bundle-flow";
import { createBundleHostProvider } from "@mycadet/electron-desktop/bundle-host";
import type {
  CapabilityModule,
  DesktopCapabilityRegistry,
} from "@mycadet/electron-desktop/capability-registry";
import { onFileOpen } from "@mycadet/electron-desktop/file-open";
import { LOCAL_MODE_CLI } from "@mycadet/electron-desktop/local-mode";

import { getRendererBase } from "../app-config";
import { handle, on } from "../ipc.client";

const bundles: CapabilityModule<DesktopCapabilityRegistry> = {
  id: "windows.bundles",
  install(registry) {
    configureBundlePlatform({
      // Modules install synchronously in path order and `local-mode` (the CLI
      // provider) sorts after this one, while a cold launch from a `.vellum`
      // file replays argv during `file-open`'s install. Yielding once lets
      // every module finish installing before the CLI is looked up.
      ...createBundleHostProvider(async () => {
        await Promise.resolve();
        return registry.require(LOCAL_MODE_CLI).resolveInvocation();
      }),
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
