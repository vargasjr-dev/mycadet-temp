import { app } from "electron";
import { z } from "zod";

import { handle } from "./ipc";

export interface LaunchAtLoginStore {
  read: () => boolean | null;
  subscribe: (listener: () => void) => () => void;
  write: (enabled: boolean) => void;
}

export interface LoginItemRuntime {
  identity?: { path: string; args: string[] };
  store?: LaunchAtLoginStore;
}

let runtime: LoginItemRuntime | null = null;
let teardown: (() => void) | null = null;

export const configureLoginItem = (next: LoginItemRuntime): void => {
  runtime = next;
};

const requireRuntime = (): LoginItemRuntime => {
  if (!runtime) {
    throw new Error("Login-item runtime is unavailable");
  }
  return runtime;
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
  const configured = requireRuntime();
  const { store } = configured;
  if (!store || teardown) {
    return;
  }
  if (store.read() === null) {
    store.write(app.getLoginItemSettings(configured.identity).openAtLogin);
  }
  syncLoginItem();
  teardown = store.subscribe(syncLoginItem);
};

export const __resetLoginItemForTesting = (): void => {
  teardown?.();
  teardown = null;
  runtime = null;
};
