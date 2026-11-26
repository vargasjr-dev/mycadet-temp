import { expect, mock, test } from "bun:test";

import { electronMock } from "../../../test-setup";

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

import { PERMISSION_GUIDE_STATE } from "@mycadet/ipc-contract";

// The real factory, so the seam is held to the bridge the composition
// actually exposes. Imported after the electron mock — the preload graph
// reads `ipcRenderer` when it evaluates.
const { createPermissionSetupBridge } = await import("./permissions");
const bridge = createPermissionSetupBridge();

test("permission guide drag sends only its id and releases state subscriptions", () => {
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
