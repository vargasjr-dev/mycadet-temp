import { expect, mock, test } from "bun:test";
import { electronMock } from "@mycadet/electron-desktop/test-setup";

import { CADET_BRIDGE_KEYS, type CadetBridge } from "@mycadet/ipc-contract";

const exposed = new Map<string, unknown>();
const ipcRenderer = {
  invoke: mock(() => Promise.resolve()),
  off: mock(() => undefined),
  on: mock(() => undefined),
  send: mock(() => undefined),
  sendSync: mock(() => null),
};
mock.module("electron", () =>
  electronMock({
    contextBridge: {
      exposeInMainWorld: (key: string, value: unknown) => {
        exposed.set(key, value);
      },
    },
    ipcRenderer,
    webUtils: { getPathForFile: mock(() => "") },
  }),
);

// The composition is one shared object literal that branches on
// `process.platform` (a real preload runs once per platform), so each
// platform's surface is composed under a mocked platform. The module is
// imported once — it reads the platform at compose time, not import time.
const { composeDesktopPreload } =
  await import("@mycadet/electron-desktop/preload");

const composeUnder = (platform: string): Partial<CadetBridge> => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  if (descriptor) {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: platform,
    });
  }
  try {
    return composeDesktopPreload();
  } finally {
    if (descriptor) {
      Object.defineProperty(process, "platform", descriptor);
    }
  }
};

/** Dotted paths of every leaf (method or scalar) under a bridge value. */
const surface = (value: unknown, prefix = ""): string[] => {
  if (typeof value !== "object" || value === null) {
    return [prefix];
  }
  return Object.entries(value)
    .flatMap(([key, child]) => surface(child, key ? `${prefix}.${key}` : key))
    .sort();
};

test("the shell index composes and exposes the shared bridge", async () => {
  await import("./index");
  expect(exposed.get("cadet")).toBeDefined();
});

test("the composed Windows bridge satisfies every CadetBridge key", () => {
  const bridge = composeUnder("win32");

  for (const key of CADET_BRIDGE_KEYS) {
    expect(bridge[key], key).toBeDefined();
  }
  expect(Object.keys(bridge).sort()).toEqual([...CADET_BRIDGE_KEYS].sort());
});

// Windows shares the Linux hotkey chord flavor and adds the native
// title-bar overlay seam; macOS's raw-keyboard surfaces are its alone.
const WINDOWS_ONLY_SURFACE = [
  "helper.hotkey.onRegistrationChange",
  "helper.hotkey.setVoiceModeChord",
  "mainWindow.setTitleBarOverlay",
];
const MACOS_ONLY_SURFACE = [
  "helper.apps.frontmost",
  "helper.apps.quit",
  "helper.apps.running",
  "helper.hotkey.readFrontSelection",
  "helper.hotkey.setChords",
  "helper.hotkey.setModifierHold",
  "helper.input.onActivity",
  "helper.input.setActivityWatch",
  "permissions.setup.begin",
  "permissions.setup.cancel",
  "permissions.setup.dismiss",
  "permissions.setup.getGuide",
  "permissions.setup.onGuide",
  "permissions.setup.ready",
  "permissions.setup.revealApp",
  "permissions.setup.startDrag",
  "text.undoInFrontApp",
];

test("the Windows bridge matches the macOS bridge surface up to the documented deltas", () => {
  const bridge = composeUnder("win32");
  const macBridge = composeUnder("darwin");

  const windowsSurface = CADET_BRIDGE_KEYS.flatMap((key) =>
    surface(bridge[key], key),
  );
  const macSurface = CADET_BRIDGE_KEYS.flatMap((key) =>
    surface(macBridge[key], key),
  );

  const windowsOnly = windowsSurface.filter((p) => !macSurface.includes(p));
  const macOnly = macSurface.filter((p) => !windowsSurface.includes(p));
  expect(windowsOnly.sort()).toEqual(WINDOWS_ONLY_SURFACE);
  expect(macOnly.sort()).toEqual(MACOS_ONLY_SURFACE);
});
