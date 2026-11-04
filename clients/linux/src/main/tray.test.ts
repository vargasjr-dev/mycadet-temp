import { beforeEach, expect, mock, test } from "bun:test";

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

type TrayRuntime = {
  accelerator: (kind: string) => { accelerator?: string };
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

const { installLinuxTray } = await import("./tray");

beforeEach(() => {
  trayRuntime = null;
});

test("exposes menu accelerators and themed icons", () => {
  installLinuxTray();

  expect(trayRuntime?.accelerator("newConversation")).toEqual({
    accelerator: "CmdOrCtrl+N",
  });
  expect(trayRuntime?.icon("settings")).toBe(themedIcon);
});
