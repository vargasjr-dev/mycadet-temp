import { autoUpdater } from "electron-updater";

import {
  configureAutoUpdate,
  resolveUpdateFeedUrl,
} from "@mycadet/electron-desktop/auto-update";

import { handle } from "./ipc";
import log from "@mycadet/electron-desktop/app-logger";

configureAutoUpdate({
  updater: autoUpdater,
  ipc: { handle },
  logger: log,
  feedUrl: resolveUpdateFeedUrl("mac-electron", process.arch),
});
