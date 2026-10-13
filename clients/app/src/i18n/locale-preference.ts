import { getDeviceSetting, setDeviceSetting } from "@app/utils/device-settings";

export function readLocalePreference(): string {
  return getDeviceSetting("locale", "");
}

export function writeLocalePreference(locale: string): void {
  setDeviceSetting("locale", locale);
}
