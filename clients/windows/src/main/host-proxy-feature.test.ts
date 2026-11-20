import { afterEach, expect, mock, test } from "bun:test";
import { electronMock } from "../../test-setup";

const quitListeners: Array<() => void> = [];

mock.module("electron", () =>
  electronMock({
    app: {
      getVersion: () => "0.0.0",
      getName: () => "Cadet",
      isPackaged: false,
      getPath: () => "/tmp",
      once: (event: string, listener: () => void) => {
        if (event === "before-quit") {
          quitListeners.push(listener);
        }
      },
    },
    BrowserWindow: { getAllWindows: () => [] },
    powerMonitor: {
      on: () => undefined,
      off: () => undefined,
      getSystemIdleTime: () => 0,
      getSystemIdleState: () => "active",
    },
    safeStorage: {
      isEncryptionAvailable: () => false,
      encryptString: (value: string) => Buffer.from(value),
      decryptString: (value: Buffer) => value.toString(),
    },
  }),
);

mock.module("electron-log/main", () => {
  const noop = () => {};
  return {
    default: {
      info: noop,
      warn: noop,
      error: noop,
      debug: noop,
      initialize: noop,
      transports: {
        file: {
          maxSize: 0,
          fileName: "",
          format: "",
          getFile: () => ({ path: "" }),
        },
      },
    },
  };
});

const { routerTesting } = await import("@mycadet/electron-desktop");
const { default: hostProxyFeature } = await import("./features/host-proxy");
const { COMPUTER_USE_ACTION_EXECUTORS } =
  await import("./features/computer-use-actions");
const { DesktopCapabilityRegistry } =
  await import("@mycadet/electron-desktop/capability-registry");

afterEach(() => {
  routerTesting.reset();
  quitListeners.length = 0;
});

test("installs the bridge with the portable executors and tears down on quit", async () => {
  hostProxyFeature.install(new DesktopCapabilityRegistry());

  // The bridge install is deferred a microtask so the lockfile watcher's
  // initial read (a later-sorted feature) lands first.
  expect(routerTesting.executors.size).toBe(0);
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect([...routerTesting.executors.keys()].sort()).toEqual([
    "host_bash",
    "host_browser",
    "host_file",
    "host_transfer",
    "host_ui_snapshot",
  ]);
  expect(routerTesting.connections.size).toBe(0);

  expect(quitListeners.length).toBe(1);
  quitListeners[0]();
  expect(routerTesting.executors.size).toBe(0);
});

test("installs the computer-use executor contributed by its capability", async () => {
  const registry = new DesktopCapabilityRegistry();
  registry.provide(COMPUTER_USE_ACTION_EXECUTORS, {
    host_cu: {
      handleRequest: () => undefined,
      handleCancel: () => undefined,
    },
    teardown: () => undefined,
  });

  hostProxyFeature.install(registry);
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(routerTesting.executors.has("host_cu")).toBe(true);
});
