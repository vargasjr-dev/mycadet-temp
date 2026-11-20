import { beforeEach, expect, mock, test } from "bun:test";
import { electronMock } from "@mycadet/electron-desktop/test-setup";

const trayIcon = { isEmpty: () => false };
// Only the deltas: the shared mock already covers every default the tray
// reads (`getVersion`, `getName`, `isPackaged`, `showAboutPanel`, and
// `shell.openExternal` among them), so the registration carries the two
// values this file actually seams — the app path the tray resolves CLI
// paths against, and the icon source.
mock.module("electron", () =>
  electronMock({
    app: { getAppPath: () => "/app" },
    nativeImage: { createFromPath: () => trayIcon },
  }),
);

type TrayRuntime = {
  accelerator: (kind: string) => { accelerator?: string };
  icon: (icon: string) => unknown;
};
let trayRuntime: TrayRuntime | null = null;
mock.module("@mycadet/electron-desktop/status-icon", () => ({
  statusColor: () => undefined,
  compositeStatusDot: () => undefined,
  buildStatusIcon: () => undefined,
  statusFrames: () => undefined,
  invalidateIconCache: () => undefined,
  __resetForTesting: () => undefined,
  configureStatusIconFallback: () => undefined,
}));
mock.module("@mycadet/electron-desktop/window-state", () => ({
  clearCompanionIntroSeen: () => undefined,
  onCompanionHiddenChange: () => () => undefined,
  readCompanionCallDock: () => undefined,
  readCompanionHidden: () => false,
  readCompanionIntroSeenVersion: () => undefined,
  readCompanionSize: () => undefined,
  readTitleBarOverlayTheme: () => undefined,
  restoreBounds: () => undefined,
  track: () => undefined,
  writeCompanionCallDock: () => undefined,
  writeCompanionHidden: () => undefined,
  writeCompanionIntroSeen: () => undefined,
  writeCompanionSize: () => undefined,
  writeOnboardingActive: () => undefined,
  writeTitleBarOverlayTheme: () => undefined,
  readOnboardingActive: () => false,
}));
mock.module("@mycadet/electron-desktop/about", () => ({
  configureAboutRuntime: () => undefined,
  getVersionInfo: () => ({ version: "0.0.0" }),
  installAbout: () => undefined,
  openAboutWindow: () => undefined,
}));
mock.module("@mycadet/electron-desktop/commands", () => ({
  readHotkeyOverride: () => undefined,
  readHotkeyOverrides: () => undefined,
  writeHotkeyOverrides: () => undefined,
  GLOBAL_SHORTCUT_DEFAULTS: () => undefined,
  resolveAccelerator: () => undefined,
  HOTKEY_SETTINGS: "hotkeys",
  configureHotkeySettings: () => undefined,
  dispatchToFocused: () => undefined,
  onHotkeyOverridesChange: () => () => undefined,
  acceleratorOption: (kind: string) =>
    kind === "newConversation" ? { accelerator: "CmdOrCtrl+N" } : {},
}));
const themedIcon = { dark: false };
mock.module("./menu-icon", () => ({
  menuIcon: () => () => themedIcon,
}));
mock.module("@mycadet/electron-desktop/tray-model", () => ({
  __resetForTesting: () => undefined,
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
