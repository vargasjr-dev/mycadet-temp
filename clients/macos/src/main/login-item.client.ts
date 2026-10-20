import { app } from "electron";

import {
  configureLoginItem,
  installLoginItem as installPackagedLoginItem,
  installLoginItemIpc,
} from "@mycadet/electron-desktop/login-item";
import {
  onSettingChange,
  readSetting,
  writeSetting,
} from "@mycadet/electron-desktop/settings";

import { handle } from "./ipc";

configureLoginItem({
  handle,
  store: {
    read: () => readSetting("launchAtLogin"),
    subscribe: (listener) => onSettingChange("launchAtLogin", listener),
    write: (enabled) => {
      writeSetting("launchAtLogin", enabled);
    },
  },
});

/**
 * `setLoginItemSettings` fails in dev ("Operation not permitted" — the
 * unpacked binary can't register as a login item); only packaged builds
 * register at boot. Linux and Windows keep the package's unguarded
 * `installLoginItem` — their dev identity (the electron binary plus the
 * entry script) registers fine unpacked.
 */
export const installLoginItem = (): void => {
  if (!app.isPackaged) {
    return;
  }
  installPackagedLoginItem();
};

export { installLoginItemIpc };
