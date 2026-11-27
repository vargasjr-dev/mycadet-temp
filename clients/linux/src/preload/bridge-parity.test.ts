import { expect, mock, test } from "bun:test";
import { electronMock } from "@mycadet/electron-desktop/test-setup";

import { CADET_BRIDGE_KEYS } from "@mycadet/ipc-contract";

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
test("the shell index composes and exposes the shared bridge", async () => {
  await import("./index");
  expect(exposed.get("cadet")).toBeDefined();
});

test("the composed Linux bridge satisfies every CadetBridge key", () => {
  const bridge = composeDesktopPreload();

  for (const key of CADET_BRIDGE_KEYS) {
    expect(bridge[key], key).toBeDefined();
  }
  expect(Object.keys(bridge).sort()).toEqual([...CADET_BRIDGE_KEYS].sort());
});
