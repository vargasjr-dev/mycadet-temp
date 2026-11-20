import { autoUpdater } from "electron-updater";

import {
  configureAutoUpdate,
  resolveUpdateFeedUrl,
} from "@mycadet/electron-desktop/auto-update";

import { resolveEnvironmentName } from "@mycadet/shared";
import { handle } from "./ipc.client";
import log from "./logger";

/** Channel-specific `win-electron/{arch}/` feed for this build. */
export const windowsUpdateFeedUrl = (arch: string = process.arch): string =>
  resolveUpdateFeedUrl(resolveEnvironmentName(), "win-electron", arch);

configureAutoUpdate({
  updater: autoUpdater,
  ipc: { handle },
  logger: log,
  environment: resolveEnvironmentName(),
  feedUrl: windowsUpdateFeedUrl(),
});

export {
  checkForUpdates,
  installAutoUpdate,
  type UpdateState,
  type UpdateStatus,
} from "@mycadet/electron-desktop/auto-update";
