import { expect, mock, test } from "bun:test";
import { electronMock } from "../../test-setup";

const MOCK_DEVICE_ID = "test-device-00000000-0000-0000-0000-000000000000";

mock.module("electron", () =>
  electronMock({
    app: { isPackaged: false, once: () => undefined },
    safeStorage: { isEncryptionAvailable: () => false },
    powerMonitor: {
      getSystemIdleState: () => "active",
      addListener: () => undefined,
      removeListener: () => undefined,
    },
  }),
);

mock.module("../device-id", () => ({
  getDeviceId: () => MOCK_DEVICE_ID,
}));

const { createHostProxyRuntime } = await import("./runtime");

const unavailableExecutor = {
  handleRequest: () => undefined,
  handleCancel: () => undefined,
};

test("creates a runtime with only the committed portable executors", () => {
  const runtime = createHostProxyRuntime({
    interfaceId: "linux",
    bashExecutor: unavailableExecutor,
    logger: console,
  });

  expect(Object.keys(runtime.executors).sort()).toEqual([
    "host_bash",
    "host_browser",
    "host_file",
    "host_transfer",
    "host_ui_snapshot",
  ]);
  expect(runtime.sseClientHeaders()).toMatchObject({
    "X-Cadet-Client-Id": MOCK_DEVICE_ID,
    "X-Cadet-Interface-Id": "linux",
  });
  expect(runtime.posterClientHeaders()).toEqual({
    "X-Cadet-Client-Id": MOCK_DEVICE_ID,
  });
  expect(() => runtime.teardownExecutors?.()).not.toThrow();
});

test("adds host_cu when the shell contributes one, and tears it down", () => {
  let didTeardown = false;
  const runtime = createHostProxyRuntime({
    interfaceId: "windows",
    bashExecutor: unavailableExecutor,
    hostCu: {
      executor: unavailableExecutor,
      teardown: () => {
        didTeardown = true;
      },
    },
    logger: console,
  });

  expect(runtime.executors.host_cu).toBe(unavailableExecutor);
  runtime.teardownExecutors?.();
  expect(didTeardown).toBe(true);
});

test("the shell's capability flags ride the SSE headers", () => {
  const runtime = createHostProxyRuntime({
    interfaceId: "test-shell",
    supports: { windowCapture: true, sequence: true, coachmarks: true },
    bashExecutor: unavailableExecutor,
    logger: console,
  });

  expect(runtime.sseClientHeaders()).toMatchObject({
    "X-Cadet-Interface-Id": "test-shell",
    "X-Cadet-Cu-Window-Capture": "1",
    "X-Cadet-Cu-Sequence": "1",
    "X-Cadet-Cu-Annotate": "1",
  });
});
