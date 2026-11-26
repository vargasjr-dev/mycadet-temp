import { expect, mock, test } from "bun:test";

import { electronMock } from "@mycadet/electron-desktop/test-setup";

type Listener = (...args: unknown[]) => void;
const send = mock((_channel: string, ..._args: unknown[]) => undefined);
const on = mock((_channel: string, _listener: Listener) => undefined);
const off = mock((_channel: string, _listener: Listener) => undefined);

mock.module("electron", () =>
  electronMock({
    ipcRenderer: {
      invoke: mock(() => Promise.resolve(null)),
      send,
      on,
      off,
    },
    webUtils: { getPathForFile: () => "" },
  }),
);

import {
  PERMISSION_GUIDE_STATE,
  type CadetBridge,
} from "@mycadet/ipc-contract";

// The real composition, so the mac-only feature is held to the bridge the
// shared features actually open. Imported after the electron mock — the
// preload graph reads `ipcRenderer` when it evaluates.
const { composeDesktopPreload } =
  await import("@mycadet/electron-desktop/preload");
const { install } = await import("./permissions-setup");

const shared: Partial<CadetBridge> = composeDesktopPreload({});
install(shared);
const bridge = shared.permissions?.setup;

test("permission guide drag sends only its id and releases state subscriptions", () => {
  if (!bridge) throw new Error("permissions.setup was not contributed");
  bridge.cancel();
  expect(send).toHaveBeenCalledWith("cadet:permissions:guide:cancel");
  bridge.startDrag(7);
  expect(send).toHaveBeenCalledWith("cadet:permissions:guide:drag", 7);
  const unsubscribe = bridge.onGuide(() => undefined);
  const guideListeners = on.mock.calls.filter(
    ([channel]) => channel === PERMISSION_GUIDE_STATE,
  ).length;
  expect(guideListeners).toBe(1);
  unsubscribe();
  const guideRemovals = off.mock.calls.filter(
    ([channel]) => channel === PERMISSION_GUIDE_STATE,
  ).length;
  expect(guideRemovals).toBe(1);
});
