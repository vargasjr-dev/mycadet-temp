import { autoUpdater } from "electron-updater";

import {
  configureAutoUpdate,
  resolveUpdateFeedUrl,
} from "@mycadet/electron-desktop/auto-update";

import { handle } from "./ipc.client";
import { log } from "@mycadet/electron-desktop";

/** Channel-specific `linux-electron/{arch}/` feed for this build. */
const linuxUpdateFeedUrl = (): string =>
  resolveUpdateFeedUrl("linux-electron", process.arch);

configureAutoUpdate({
  updater: autoUpdater,
  ipc: { handle },
  logger: log,
  feedUrl: linuxUpdateFeedUrl(),
});

export {
  checkForUpdates,
  installAutoUpdate,
  type UpdateState,
  type UpdateStatus,
} from "@mycadet/electron-desktop/auto-update";
