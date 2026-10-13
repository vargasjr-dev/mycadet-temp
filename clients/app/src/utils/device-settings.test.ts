import { afterEach, expect, test } from "bun:test";
import {
  deviceKey,
  getDeviceSetting,
  setDeviceSetting,
} from "@app/utils/device-settings";
import { watchSetting } from "@app/utils/local-settings";
import { runStorageMigrations } from "@app/utils/storage-migration";

afterEach(() => localStorage.clear());

test("the locale preference persists under its existing device key", () => {
  setDeviceSetting("locale", "es");
  runStorageMigrations();
  expect(deviceKey("locale")).toBe("device:locale");
  expect(getDeviceSetting("locale", "en")).toBe("es");
  expect(localStorage.getItem("device:locale")).toBe("es");
});

test("same-tab setting observers see locale updates and can unsubscribe", () => {
  let notifications = 0;
  const stop = watchSetting(deviceKey("locale"), () => notifications++);
  try {
    setDeviceSetting("locale", "es");
    expect(notifications).toBe(1);
    stop();
    setDeviceSetting("locale", "en");
    expect(notifications).toBe(1);
  } finally {
    stop();
  }
});
