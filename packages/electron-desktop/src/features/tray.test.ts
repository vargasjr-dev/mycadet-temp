import type { NativeImage } from "electron";
import { beforeEach, expect, mock, test } from "bun:test";

type TrayRuntime = {
  accelerator: (kind: string) => { accelerator?: string };
  icon: (icon: string) => unknown;
  companionSupported: () => boolean;
  companionHidden: () => boolean;
  companionSize: (axis: string) => unknown;
  removePairedLabel: string;
};
let trayRuntime: TrayRuntime | null = null;
mock.module("../status-icon", () => ({
  statusColor: () => undefined,
  compositeStatusDot: () => undefined,
  buildStatusIcon: () => undefined,
  statusFrames: () => undefined,
  invalidateIconCache: () => undefined,
  __resetForTesting: () => undefined,
  configureStatusIconFallback: () => undefined,
}));
mock.module("../window-state", () => ({
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
mock.module("../about", () => ({
  configureAboutRuntime: () => undefined,
  getVersionInfo: () => ({ version: "0.0.0" }),
  installAbout: () => undefined,
  openAboutWindow: () => undefined,
}));
mock.module("../commands", () => ({
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
mock.module("../menu-icon", () => ({
  menuIcon: () => () => themedIcon,
}));
mock.module("../tray-model", () => ({
  __resetForTesting: () => undefined,
  configureTrayModel: (runtime: TrayRuntime) => {
    trayRuntime = runtime;
  },
  installTray: () => undefined,
}));
mock.module("../taskbar", () => ({
  installTaskbar: () => undefined,
}));
mock.module("../main-window", () => ({
  current: () => null,
  ensureVisible: () => undefined,
  toggleVisibility: () => undefined,
}));

const { install } = await import("./tray");

beforeEach(() => {
  trayRuntime = null;
});

test("exposes menu accelerators and themed icons with no shell input", () => {
  install();

  expect(trayRuntime?.accelerator("newConversation")).toEqual({
    accelerator: "CmdOrCtrl+N",
  });
  expect(trayRuntime?.icon("settings")).toBe(themedIcon);
});

test("the shell's icon renderer and companion wiring win over the defaults", () => {
  const shellIcon = { template: true } as unknown as NativeImage;
  install({
    icon: () => shellIcon,
    companion: {
      supported: () => true,
      hidden: () => false,
      size: () => "small",
      setVisible: () => undefined,
      setSize: () => undefined,
    },
    removePairedLabel: "Remove from this Mac\u2026",
  });

  expect(trayRuntime?.icon("settings")).toBe(shellIcon);
  expect(trayRuntime?.companionSupported()).toBe(true);
  expect(trayRuntime?.companionHidden()).toBe(false);
  expect(trayRuntime?.companionSize("height")).toBe("small");
  expect(trayRuntime?.removePairedLabel).toBe("Remove from this Mac\u2026");
});
