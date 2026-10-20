import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  deviceKey,
  getDeviceBool,
  getDeviceSetting,
  setDeviceSetting,
} from "./device-settings";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe("deviceKey", () => {
  test("returns device:-prefixed key", () => {
    expect(deviceKey("theme")).toBe("device:theme");
    expect(deviceKey("biometricEnabled")).toBe("device:biometric_enabled");
    expect(deviceKey("dockBadgesEnabled")).toBe("device:dock_badges_enabled");
    expect(deviceKey("lastUserId")).toBe("device:last_user_id");
  });
});

describe("getDeviceSetting / setDeviceSetting", () => {
  test("reads and writes device-prefixed keys", () => {
    setDeviceSetting("theme", "dark");
    expect(getDeviceSetting("theme", "system")).toBe("dark");
    expect(localStorage.getItem("device:theme")).toBe("dark");
  });

  test("returns fallback when key is absent", () => {
    expect(getDeviceSetting("theme", "system")).toBe("system");
  });

  test("ignores the pre-migration cadet_ key", () => {
    localStorage.setItem("cadet_theme", "dark");
    expect(getDeviceSetting("theme", "system")).toBe("system");
  });
});

describe("getDeviceBool", () => {
  test("reads device: key as boolean", () => {
    localStorage.setItem("device:dock_badges_enabled", "true");
    expect(getDeviceBool("dockBadgesEnabled", false)).toBe(true);
  });

  test("returns fallback when absent", () => {
    expect(getDeviceBool("dockBadgesEnabled", true)).toBe(true);
    expect(getDeviceBool("dockBadgesEnabled", false)).toBe(false);
  });

  test("ignores the pre-migration cadet_ key", () => {
    localStorage.setItem("cadet_dock_badges_enabled", "false");
    expect(getDeviceBool("dockBadgesEnabled", true)).toBe(true);
  });
});
