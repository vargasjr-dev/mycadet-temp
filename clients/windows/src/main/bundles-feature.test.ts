import {
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

const installBundleFlowMock = mock(() => undefined);
const handleBundleFileMock = mock(async (_filePath: string) => undefined);
const stopFileOpenMock = mock(() => undefined);
const onFileOpenMock = mock(
  (_handler: (filePath: string) => void) => stopFileOpenMock,
);
const appOnceMock = mock((_event: string, _handler: () => void) => undefined);
const getGuardianAccessTokenMock = mock(async () => ({
  ok: true as const,
  accessToken: "guardian-token",
}));

mock.module("electron", () => ({
  app: {
    getPath: () => "C:\\Cadet",
    isPackaged: true,
    once: appOnceMock,
  },
  BrowserWindow: class {},
  session: { defaultSession: {} },
  shell: {},
}));

mock.module("@mycadet/electron-desktop/bundle-flow", () => ({
  installBundleFlow: installBundleFlowMock,
  handleBundleFile: handleBundleFileMock,
}));

mock.module("@mycadet/electron-desktop/file-open", () => ({
  onFileOpen: onFileOpenMock,
}));

const localMode = await import("@mycadet/local-mode");
mock.module("@mycadet/local-mode", () => ({
  ...localMode,
  getGuardianAccessToken: getGuardianAccessTokenMock,
  readLockfile: () => ({ assistants: [], activeAssistant: null }),
  resolveConfigDir: () => "C:\\Cadet\\config",
  resolveLockfilePaths: () => ["C:\\Cadet\\lockfile.json"],
}));

mock.module("./ipc.client", () => ({
  handle: () => undefined,
  on: () => undefined,
}));

const { bundleFileHandlerToken, getBundlePlatform } = await import(
  "@mycadet/electron-desktop/bundle-platform"
);
const { resetBundlePlatformForTest } = await import(
  "@mycadet/electron-desktop/bundle-platform"
);
const { DesktopCapabilityRegistry } =
  await import("@mycadet/electron-desktop/capability-registry");
const { default: bundles } = await import("./features/bundles");

beforeEach(() => {
  resetBundlePlatformForTest();
  installBundleFlowMock.mockClear();
  handleBundleFileMock.mockClear();
  onFileOpenMock.mockClear();
  stopFileOpenMock.mockClear();
  appOnceMock.mockClear();
  getGuardianAccessTokenMock.mockClear();
});

describe("Windows bundle workflow", () => {
  test("installs the bundle flow and file-open handler", () => {
    const registry = new DesktopCapabilityRegistry();
    bundles.install(registry);

    expect(registry.get(bundleFileHandlerToken)).toBe(handleBundleFileMock);
    expect(installBundleFlowMock).toHaveBeenCalledTimes(1);
    expect(onFileOpenMock).toHaveBeenCalledTimes(1);
    onFileOpenMock.mock.calls[0]![0]("C:\\bundle.cadet");
    expect(handleBundleFileMock).toHaveBeenCalledWith("C:\\bundle.cadet");
    expect(appOnceMock).toHaveBeenCalledWith("before-quit", stopFileOpenMock);
    expect(getBundlePlatform().bundlesRoot()).toBe("C:\\Cadet/bundles");
  });

  test("mints gateway tokens through the shared host provider", async () => {
    const registry = new DesktopCapabilityRegistry();
    bundles.install(registry);

    // The lockfile-backed provider resolves the active gateway itself; the
    // token mint delegates to the shared package (mocked here).
    await expect(
      getBundlePlatform().acquireGatewayToken("assistant-1"),
    ).resolves.toBe("guardian-token");
    expect(getGuardianAccessTokenMock).toHaveBeenCalledWith("assistant-1");
  });
});
