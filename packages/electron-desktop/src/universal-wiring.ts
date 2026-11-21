import { installAutoUpdate } from "./auto-update";
import { configureHotkeySettings, settingsHotkeySettings } from "./commands";

/**
 * The wiring every desktop shell shipped identically: the settings-store
 * hotkey settings provider and the auto-update install (the same call the
 * three clients made, modulo a platform bucket this process derives itself).
 * `startApp` runs it once, before the client's own setup.
 */
export const installUniversalFeatures = (): void => {
  configureHotkeySettings(settingsHotkeySettings);
  installAutoUpdate();
};
