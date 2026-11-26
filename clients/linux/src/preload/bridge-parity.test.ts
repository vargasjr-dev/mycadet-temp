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

const { LINUX_NOT_APPLICABLE_CAPABILITIES } =
  await import("./core-capabilities");

// The composition under test is the shell's own preload index — the
// same module the packaged preload runs — not a test-side rebuild.
await import("./index");
const linuxBridge = exposed.get("cadet") as CadetBridge;
await import("../../../macos/src/preload/index");
const macBridge = exposed.get("cadet") as CadetBridge;

const surface = (value: unknown, prefix = ""): string[] => {
  if (typeof value !== "object" || value === null) {
    return [prefix];
  }
  return Object.entries(value)
    .flatMap(([key, child]) =>
      surface(child, prefix ? `${prefix}.${key}` : key),
    )
    .sort();
};

const NOT_APPLICABLE: readonly string[] = LINUX_NOT_APPLICABLE_CAPABILITIES;
const required = CADET_BRIDGE_KEYS.filter(
  (key) => !NOT_APPLICABLE.includes(key),
);

const LINUX_ONLY_SURFACE = [
  "helper.hotkey.onRegistrationChange",
  "helper.hotkey.setVoiceModeChord",
];
// The macOS helper watches the raw keyboard, which is where the voice key's
// hold comes from. The Linux sidecar has no such monitor, so its hotkey
// surface is the shortcut chord alone.
const MACOS_ONLY_SURFACE = [
  "helper.apps.frontmost",
  "helper.apps.quit",
  "helper.apps.running",
  "helper.hotkey.readFrontSelection",
  "helper.hotkey.setChords",
  "helper.hotkey.setModifierHold",
  "helper.input.onActivity",
  "helper.input.setActivityWatch",
  // macOS System Settings accepts native application-bundle drops.
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

test("the composed Linux bridge satisfies every applicable CadetBridge key", () => {
  const bridge = linuxBridge;

  for (const key of required) {
    expect(bridge[key], key).toBeDefined();
  }
  expect(Object.keys(bridge).sort()).toEqual([...required].sort());
  expect(bridge.hostOS).toBe("linux");
});

test("the Linux bridge matches the macOS bridge surface up to the documented deltas", () => {
  expect(macBridge).toBeDefined();
  expect(macBridge.hostOS).toBe("macos");
  // The macOS main registers no menu IPC, so its preload omits the
  // surface entirely — the menu.* methods below are Linux deltas.
  expect(Object.keys(macBridge).sort()).toEqual(
    [...CADET_BRIDGE_KEYS].filter((key) => key !== "menu").sort(),
  );

  const bridge = linuxBridge;
  // The menu surface is asserted separately below: macOS registers no
  // menu IPC, so its preload omits the key entirely.
  const shared = required.filter((key) => key !== "hostOS" && key !== "menu");
  expect(macBridge.menu).toBeUndefined();
  expect(linuxBridge.menu).toBeDefined();
  const linuxSurface = shared.flatMap((key) => surface(bridge[key], key));
  const macSurface = shared.flatMap((key) => surface(macBridge[key], key));

  const linuxOnly = linuxSurface.filter((p) => !macSurface.includes(p));
  const macOnly = macSurface.filter((p) => !linuxSurface.includes(p));
  expect(linuxOnly.sort()).toEqual(LINUX_ONLY_SURFACE);
  expect(macOnly.sort()).toEqual(MACOS_ONLY_SURFACE);
});
