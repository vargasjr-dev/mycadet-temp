import {
  configureHotkeySettings,
  type HotkeySettingsProvider,
} from "@mycadet/electron-desktop/commands";

import {
  onSettingChange,
  readSetting,
  writeSetting,
} from "@mycadet/electron-desktop/settings";

const provider: HotkeySettingsProvider = {
  read: () => ({ ...(readSetting("hotkeys") ?? {}) }),
  write: (hotkeys) => {
    writeSetting("hotkeys", hotkeys);
  },
  subscribe: (listener) => onSettingChange("hotkeys", listener),
};

configureHotkeySettings(provider);

export * from "@mycadet/electron-desktop/commands";
