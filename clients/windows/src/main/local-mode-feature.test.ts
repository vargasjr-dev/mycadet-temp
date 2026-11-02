import { beforeEach, expect, mock, test } from "bun:test";

mock.module("electron", () => ({
  app: {
    getAppPath: () => import.meta.dir,
    getPath: () => import.meta.dir,
    getVersion: () => "0.0.0",
    isPackaged: false,
  },
}));

const installLocalMode = mock(() => undefined);
mock.module("@mycadet/electron-desktop/local-mode", () => ({
  installLocalMode,
}));

const refreshLockfileNow = mock(() => undefined);
mock.module("@mycadet/electron-desktop/lockfile-watcher", () => ({
  refreshLockfileNow,
}));
mock.module("./ipc.client", () => ({ handle: mock(() => undefined) }));

const { DesktopCapabilityRegistry } =
  await import("@mycadet/electron-desktop/capability-registry");
const { default: localModeFeature } = await import("./features/local-mode");

beforeEach(() => {
  mock.clearAllMocks();
});

test("local-mode installs the bridge with the host's transport directly", () => {
  const registry = new DesktopCapabilityRegistry();

  localModeFeature.install(registry);

  expect(installLocalMode).toHaveBeenCalledWith({
    handle: expect.anything(),
    refreshLockfile: refreshLockfileNow,
  });
});
