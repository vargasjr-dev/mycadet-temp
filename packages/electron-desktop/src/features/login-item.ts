import { app } from "electron";

import {
  configureLoginItem,
  installLoginItem,
  installLoginItemIpc,
} from "../login-item";
import { onSettingChange, readSetting, writeSetting } from "../settings";

export const install = (): void => {
  configureLoginItem({
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
