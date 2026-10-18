import { beforeEach, expect, mock, test } from "bun:test";
import type { Lockfile } from "@mycadet/local-mode/contract";

const trayIcon = { isEmpty: () => false };
mock.module("electron", () => ({
  app: {
    getAppPath: () => "/app",
    isPackaged: false,
    showAboutPanel: () => undefined,
  },
  nativeImage: { createFromPath: () => trayIcon },
  shell: { openExternal: () => Promise.resolve() },
}));

let currentLockfile: Lockfile = {
  assistants: [{ assistantId: "assistant-1", cloud: "cadet" }],
  activeAssistant: "assistant-1",
};
const getWatchedLockfile = mock(() => currentLockfile);
mock.module("@mycadet/electron-desktop/lockfile-watcher", () => ({
  getWatchedLockfile,
}));

type TrayRuntime = {
  accelerator: (kind: string) => { accelerator?: string };
  getLockfile: () => Lockfile;
  icon: (icon: string) => unknown;
};
let trayRuntime: TrayRuntime | null = null;
mock.module("@mycadet/electron-desktop/status-icon", () => ({
  configureStatusIconFallback: () => undefined,
}));
mock.module("@mycadet/electron-desktop/window-state", () => ({
  readOnboardingActive: () => false,
}));
mock.module("@mycadet/electron-desktop/about", () => ({
  openAboutWindow: () => undefined,
}));
mock.module("@mycadet/electron-desktop/commands", () => ({
  acceleratorOption: (kind: string) =>
    kind === "newConversation" ? { accelerator: "CmdOrCtrl+N" } : {},
}));
const themedIcon = { dark: false };
mock.module("./menu-icon", () => ({
  menuIcon: () => () => themedIcon,
}));
mock.module("@mycadet/electron-desktop/tray-model", () => ({
  configureTrayModel: (runtime: TrayRuntime) => {
    trayRuntime = runtime;
  },
  installTray: () => undefined,
}));
mock.module("./main-window", () => ({
  current: () => null,
  ensureVisible: () => undefined,
  toggleVisibility: () => undefined,
}));

const { installWindowsTray } = await import("./tray");

beforeEach(() => {
  trayRuntime = null;
  currentLockfile = {
    assistants: [{ assistantId: "assistant-1", cloud: "cadet" }],
    activeAssistant: "assistant-1",
  };
  getWatchedLockfile.mockClear();
});

test("serves tray menus from the shared lockfile watcher", () => {
  installWindowsTray();

  expect(trayRuntime?.getLockfile()).toEqual(currentLockfile);
  currentLockfile = { assistants: [], activeAssistant: null };
  expect(trayRuntime?.getLockfile()).toEqual(currentLockfile);
  expect(getWatchedLockfile).toHaveBeenCalledTimes(2);
});

test("exposes menu accelerators and themed icons", () => {
  installWindowsTray();

  expect(trayRuntime?.accelerator("newConversation")).toEqual({
    accelerator: "CmdOrCtrl+N",
  });
  expect(trayRuntime?.icon("settings")).toBe(themedIcon);
});
