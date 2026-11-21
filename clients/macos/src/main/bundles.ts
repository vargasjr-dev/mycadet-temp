import { app } from "electron";
import path from "node:path";

import {
  BUNDLES_DIR_NAME,
  configureBundlePlatform,
} from "@mycadet/electron-desktop/bundle-platform";
import { installBundleFlow } from "@mycadet/electron-desktop/bundle-flow";
import { createBundleHostProvider } from "@mycadet/electron-desktop";

import { RENDERER_BASE_PROD } from "@mycadet/electron-desktop";

export const installMacBundleWorkflow = (): void => {
  configureBundlePlatform({
    ...createBundleHostProvider(),
    bundlesRoot: () => path.join(app.getPath("userData"), BUNDLES_DIR_NAME),
    rendererBase: () => RENDERER_BASE_PROD,
  });
  installBundleFlow();
};
