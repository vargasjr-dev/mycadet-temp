import { app } from "electron";

import {
  configureDeepLinks,
  installDeepLinks,
  configureLoginItem,
  installLoginItem,
  installLoginItemIpc,
} from "@mycadet/electron-desktop";
import {
  onSettingChange,
  readSetting,
  writeSetting,
} from "@mycadet/electron-desktop/settings";

import { handle, on } from "@mycadet/electron-desktop/ipc";
import { ensureVisible } from "../main-window";

export const install = (): void => {
  configureDeepLinks({
    ensureVisible,
    handle,
    initialArgv: process.argv,
    on,
  });
  installDeepLinks();

  configureLoginItem({
    handle,
    identity:
      !app.isPackaged && process.argv[1]
        ? { path: process.execPath, args: [process.argv[1]] }
        : undefined,
    store: {
      read: () => readSetting("launchAtLogin"),
      subscribe: (listener) => onSettingChange("launchAtLogin", listener),
      write: (enabled) => {
        writeSetting("launchAtLogin", enabled);
      },
    },
  });
  installLoginItem();
  installLoginItemIpc();
};
