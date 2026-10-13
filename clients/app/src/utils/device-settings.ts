/**
 * Typed registry and accessors for device-scoped localStorage settings.
 *
 * Device-level settings survive logout — they describe the physical
 * device's preferences, not a user account. The `device:` key prefix
 * makes this intent explicit and enables zero-maintenance cleanup in
 * session-cleanup.ts: any key starting with `device:` is automatically
 * preserved, everything else matching app prefixes is cleared.
 *
 * To add a new device setting:
 * 1. Add an entry to DEVICE_SETTINGS below
 * 2. Use getDeviceSetting / setDeviceSetting in your component
 * No cleanup list to update, no separate file to maintain.
 *
 * References:
 * - docs/STATE_MANAGEMENT.md — Logout and device-scoped storage
 */

import {
  setLocalBool,
  setLocalSetting,
  watchSetting,
} from "@app/utils/local-settings";

/** Prefix for all device-scoped localStorage keys. */
export const DEVICE_PREFIX = "device:";

/** One device-scoped setting: its `device:`-prefixed localStorage key. */
interface DeviceSettingEntry {
  key: string;
}

/**
 * Registry of device-scoped settings. Each entry maps a logical name
 * to its localStorage key.
 */
const DEVICE_SETTINGS = {
  locale: { key: "device:locale" },
} as const satisfies Record<string, DeviceSettingEntry>;

export type DeviceSettingName = keyof typeof DEVICE_SETTINGS;

/** Returns the `device:`-prefixed localStorage key for a setting. */
export function deviceKey(name: DeviceSettingName): string {
  return DEVICE_SETTINGS[name].key;
}

/** Read a device-scoped setting, returning `fallback` when absent or unreadable. */
export function getDeviceSetting(
  name: DeviceSettingName,
  fallback: string,
): string {
  if (typeof window === "undefined") {
    return fallback;
  }
  try {
    return localStorage.getItem(DEVICE_SETTINGS[name].key) ?? fallback;
  } catch {
    return fallback;
  }
}

/** Write a device-scoped setting. Fires the `cadet:pref-changed` event for same-tab observers. */
export function setDeviceSetting(name: DeviceSettingName, value: string): void {
  setLocalSetting(DEVICE_SETTINGS[name].key, value);
}

/** Whether a device-scoped setting is stored at all, an empty value included. */
export function hasDeviceSetting(name: DeviceSettingName): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return localStorage.getItem(DEVICE_SETTINGS[name].key) !== null;
  } catch {
    return false;
  }
}

/** Read a boolean device setting. */
export function getDeviceBool(
  name: DeviceSettingName,
  fallback: boolean,
): boolean {
  if (typeof window === "undefined") {
    return fallback;
  }
  try {
    const raw = localStorage.getItem(DEVICE_SETTINGS[name].key);
    if (raw === "true") {
      return true;
    }
    if (raw === "false") {
      return false;
    }
  } catch {
    // Storage unavailable
  }
  return fallback;
}

/** Write a boolean device setting. */
export function setDeviceBool(name: DeviceSettingName, value: boolean): void {
  setLocalBool(DEVICE_SETTINGS[name].key, value);
}

/**
 * Watch a device setting for changes (cross-tab and same-tab).
 * Returns a cleanup function that removes both listeners.
 */
export function watchDeviceSetting(
  name: DeviceSettingName,
  callback: () => void,
): () => void {
  return watchSetting(DEVICE_SETTINGS[name].key, callback);
}
