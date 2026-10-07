import { expect, mock, test } from "bun:test";

import { BridgeCapabilityRegistry } from "@mycadet/electron-desktop/capability-registry";
import {
  FILE_OPEN_DRAIN,
  FILE_OPEN_EVENT,
  FILE_OPEN_SUBSCRIBE,
  FILE_OPEN_UNSUBSCRIBE,
  type CadetBridge,
} from "@mycadet/ipc-contract";

type Listener = (...args: unknown[]) => void;

const listeners = new Map<string, Listener>();
const invoke = mock(() => Promise.resolve(["C:\\例.cadet"]));
const send = mock(() => undefined);
const off = mock(() => undefined);
const getPathForFile = mock(() => "C:\\Projects\\例.cadet");

mock.module("electron", () => ({
  ipcRenderer: {
    invoke,
    send,
    on: (channel: string, listener: Listener) => {
      listeners.set(channel, listener);
    },
    off,
  },
  webUtils: { getPathForFile },
}));

const { default: pathsModule } = await import("./features/paths");
const registry = new BridgeCapabilityRegistry<CadetBridge>({});
pathsModule.install(registry);
const bridge = registry.build();

test("resolves only native File paths and returns null when unavailable", () => {
  const file = new File(["bundle"], "例.cadet");

  expect(bridge.paths?.getPathForFile(file)).toBe("C:\\Projects\\例.cadet");
  getPathForFile.mockImplementationOnce(() => "");
  expect(bridge.paths?.getPathForFile(file)).toBeNull();
  getPathForFile.mockImplementationOnce(() => {
    throw new Error("not a native File");
  });
  expect(bridge.paths?.getPathForFile(file)).toBeNull();
});

test("drains and subscribes through the committed file-open bridge", async () => {
  expect(await bridge.fileOpen?.drain()).toEqual(["C:\\例.cadet"]);
  expect(invoke).toHaveBeenCalledWith(FILE_OPEN_DRAIN);

  const received: string[] = [];
  const unsubscribe = bridge.fileOpen?.onFile((filePath) => {
    received.push(filePath);
  });
  listeners.get(FILE_OPEN_EVENT)?.({}, "C:\\live.cadet");
  expect(received).toEqual(["C:\\live.cadet"]);
  expect(send).toHaveBeenCalledWith(FILE_OPEN_SUBSCRIBE);

  unsubscribe?.();
  expect(send).toHaveBeenCalledWith(FILE_OPEN_UNSUBSCRIBE);
  expect(off).toHaveBeenCalledWith(
    FILE_OPEN_EVENT,
    listeners.get(FILE_OPEN_EVENT),
  );
});
