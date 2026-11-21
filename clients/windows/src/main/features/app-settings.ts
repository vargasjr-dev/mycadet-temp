import type { DesktopCapabilityRegistry } from "@mycadet/electron-desktop/capability-registry";
import {
  HOTKEY_SETTINGS,
  type HotkeySettingsProvider,
} from "@mycadet/electron-desktop/commands";
import {
  onSettingChange,
  readSetting,
  writeSetting,
} from "@mycadet/electron-desktop/settings";

const hotkeySettings: HotkeySettingsProvider = {
  read: () => ({ ...(readSetting("hotkeys") ?? {}) }),
  write: (hotkeys) => {
    writeSetting("hotkeys", hotkeys);
  },
  subscribe: (listener) => onSettingChange("hotkeys", listener),
};

export const install = (capabilities: DesktopCapabilityRegistry): void => {
  capabilities.provide(HOTKEY_SETTINGS, hotkeySettings);
};
