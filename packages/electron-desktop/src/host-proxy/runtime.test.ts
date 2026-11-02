import { expect, mock, test } from "bun:test";

const MOCK_DEVICE_ID = "test-device-00000000-0000-0000-0000-000000000000";

mock.module("electron", () => ({
  app: { isPackaged: false, once: () => undefined },
  safeStorage: { isEncryptionAvailable: () => false },
  powerMonitor: {
    getSystemIdleState: () => "active",
    addListener: () => undefined,
    removeListener: () => undefined,
  },
}));

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

test("adds host_cu when the computer-use capability is installed", () => {
  let didTeardown = false;
  const runtime = createHostProxyRuntime({
    interfaceId: "windows",
    bashExecutor: unavailableExecutor,
    logger: console,
    computerUseExecutors: {
      host_cu: unavailableExecutor,
      teardown: () => {
        didTeardown = true;
      },
    },
  });

  expect(runtime.executors.host_cu).toBe(unavailableExecutor);
  runtime.teardownExecutors?.();
  expect(didTeardown).toBe(true);
});
