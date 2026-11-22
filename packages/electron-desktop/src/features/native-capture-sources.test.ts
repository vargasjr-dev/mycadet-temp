import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { electronMock } from "../../test-setup";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const appPath = mkdtempSync(path.join(tmpdir(), "cadet-capture-sources-"));

const electronApp = {
  isPackaged: false,
  getAppPath: () => appPath,
};

mock.module("electron", () => electronMock({ app: electronApp }));

const warnings: unknown[][] = [];
const infos: unknown[][] = [];
mock.module("../app-logger", () => ({
  getLogFilePaths: () => [],
  default: {
    info: (...args: unknown[]) => infos.push(args),
    warn: (...args: unknown[]) => warnings.push(args),
  },
}));

const { __resetForTesting, listWindowsWithAddon, loadNativeWindowLister } =
  await import("./native-capture-sources");

const addonPath = path.join(
  appPath,
  "resources",
  "capture-sources",
  process.arch,
  "cadet-capture-sources.node",
);

const writeFakeAddon = (): void => {
  mkdirSync(path.dirname(addonPath), { recursive: true });
  writeFileSync(addonPath, "not a mach-o dylib");
};

afterAll(() => {
  rmSync(appPath, { recursive: true, force: true });
});

describe("capture-sources addon loading", () => {
  beforeEach(() => {
    __resetForTesting();
    warnings.length = 0;
    infos.length = 0;
    delete process.env.CADET_DISABLE_NATIVE_CAPTURE_SOURCES;
    rmSync(path.join(appPath, "resources"), { recursive: true, force: true });
  });

  afterEach(() => {
    delete process.env.CADET_DISABLE_NATIVE_CAPTURE_SOURCES;
  });

  test("reports unavailable without throwing when the addon is missing", () => {
    expect(loadNativeWindowLister()).toBeNull();
    expect(listWindowsWithAddon()).resolves.toBeNull();
    expect(infos.length).toBe(1);
  });

  test("resolves the addon under resources/capture-sources/<arch> in a dev build", () => {
    loadNativeWindowLister();
    expect(String(infos[0]?.[0])).toContain(addonPath);
  });

  test("reports unavailable without throwing when the file is not an addon", () => {
    writeFakeAddon();

    expect(loadNativeWindowLister()).toBeNull();
    expect(warnings.length).toBe(1);
  });

  test("caches the load result so a failure is not retried per call", () => {
    loadNativeWindowLister();
    loadNativeWindowLister();
    loadNativeWindowLister();
    expect(infos.length).toBe(1);
  });

  test("the kill switch skips the addon without reading the file", () => {
    process.env.CADET_DISABLE_NATIVE_CAPTURE_SOURCES = "1";
    writeFakeAddon();

    expect(loadNativeWindowLister()).toBeNull();
    expect(warnings.length).toBe(0);
    expect(infos.length).toBe(1);
  });
});
