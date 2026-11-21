import { app } from "electron";

import { configureDeepLinks, installDeepLinks } from "../deep-links";
import {
  configureLoginItem,
  installLoginItem,
  installLoginItemIpc,
} from "../login-item";
import { onSettingChange, readSetting, writeSetting } from "../settings";

import { handle, on } from "../ipc";
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
