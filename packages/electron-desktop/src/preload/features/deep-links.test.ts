import { beforeEach, expect, mock, test } from "bun:test";

import { electronMock } from "../../../test-setup";

import type { CadetBridge } from "@mycadet/ipc-contract";

const invoke = mock(() => Promise.resolve());
const on = mock((_channel: string, _listener: unknown) => undefined);
const off = mock((_channel: string, _listener: unknown) => undefined);
const send = mock((_channel: string, ..._args: unknown[]) => undefined);

mock.module("electron", () =>
  electronMock({
    ipcRenderer: { invoke, off, on, send },
  }),
);

const { install: deepLinksInstall } = await import("./deep-links");

beforeEach(() => {
  invoke.mockClear();
  on.mockClear();
  off.mockClear();
  send.mockClear();
});

test("contributes deep-link delivery and launch-at-login IPC", async () => {
  const bridge: Partial<CadetBridge> = {};
  deepLinksInstall(bridge);
  const callback = mock(() => undefined);

  await bridge.deepLinks?.drain();
  const unsubscribe = bridge.deepLinks?.onLink(callback);
  await bridge.launchAtLogin?.get();
  await bridge.launchAtLogin?.set(true);

  expect(invoke).toHaveBeenCalledWith("cadet:deepLinks:drain");
  expect(send).toHaveBeenCalledWith("cadet:deepLinks:subscribe");
  expect(invoke).toHaveBeenCalledWith("cadet:launchAtLogin:get");
  expect(invoke).toHaveBeenCalledWith("cadet:launchAtLogin:set", true);

  const [channel, handler] = on.mock.calls[0] ?? [];
  if (channel !== "cadet:deepLinks:event" || !handler) {
    throw new Error("Deep-link event handler was not registered");
  }
  handler({}, { kind: "send", message: "hello" });
  expect(callback).toHaveBeenCalledWith({ kind: "send", message: "hello" });

  unsubscribe?.();
  expect(off).toHaveBeenCalledWith(
    "cadet:deepLinks:event",
    expect.any(Function),
  );
  expect(send).toHaveBeenCalledWith("cadet:deepLinks:unsubscribe");
});
