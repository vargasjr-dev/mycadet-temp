import { app } from "electron";
import { z } from "zod";

import { handle } from "./ipc";
import { onSettingChange, readSetting, writeSetting } from "./settings";

export interface LaunchAtLoginStore {
  read: () => boolean | null;
  subscribe: (listener: () => void) => () => void;
  write: (enabled: boolean) => void;
}

export interface LoginItemRuntime {
  identity?: { path: string; args: string[] };
  store?: LaunchAtLoginStore;
}

// The settings-backed store every shell ships: the launch-at-login toggle
// persists through the shared settings module unless a caller configures
// something else.
const settingsStore: LaunchAtLoginStore = {
  read: () => readSetting("launchAtLogin"),
  subscribe: (listener) => onSettingChange("launchAtLogin", listener),
  write: (enabled) => {
    writeSetting("launchAtLogin", enabled);
  },
};

let runtime: LoginItemRuntime = { store: settingsStore };
let teardown: (() => void) | null = null;

export const configureLoginItem = (next: LoginItemRuntime): void => {
  runtime = { store: settingsStore, ...next };
};

const readLaunchAtLogin = (): boolean => {
  const stored = runtime?.store?.read();
  return stored ?? app.getLoginItemSettings(runtime?.identity).openAtLogin;
};

const writeLaunchAtLogin = (enabled: boolean): void => {
  const store = runtime?.store;
  if (store) {
    store.write(enabled);
    return;
  }
  app.setLoginItemSettings({ openAtLogin: enabled, ...runtime?.identity });
};

const syncLoginItem = (): void => {
  app.setLoginItemSettings({
    openAtLogin: readLaunchAtLogin(),
    ...runtime?.identity,
  });
};

export const installLoginItemIpc = (): void => {
  handle("cadet:launchAtLogin:get", z.tuple([]), readLaunchAtLogin);
  handle("cadet:launchAtLogin:set", z.tuple([z.boolean()]), ([enabled]) => {
    writeLaunchAtLogin(enabled);
  });
};

export const installLoginItem = (): void => {
  const { store } = runtime;
  if (!store || teardown) {
    return;
  }
  if (store.read() === null) {
    store.write(app.getLoginItemSettings(runtime.identity).openAtLogin);
  }
  syncLoginItem();
  teardown = store.subscribe(syncLoginItem);
};

export const __resetLoginItemForTesting = (): void => {
  teardown?.();
  teardown = null;
  runtime = { store: settingsStore };
};
