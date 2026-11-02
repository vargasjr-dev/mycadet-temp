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
import { createBundleHostProvider } from "@mycadet/electron-desktop/bundle-host";

import { RENDERER_BASE_PROD } from "./app-config";
import { handle, on } from "./ipc";
import { resolveCliInvocation } from "./cli-invocation.client";

export const installMacBundleWorkflow = (): void => {
  configureBundlePlatform({
    ...createBundleHostProvider(),
    bundlesRoot: () => path.join(app.getPath("userData"), BUNDLES_DIR_NAME),
    rendererBase: () => RENDERER_BASE_PROD,
    ipc: { handle, on },
  });
  installBundleFlow();
};

export { handleBundleFile };
