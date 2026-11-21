import { beforeEach, describe, expect, mock, test } from "bun:test";

import { electronMock } from "../test-setup";

const appState = { isPackaged: false };
mock.module("electron", () =>
  electronMock({
    app: {
      get isPackaged() {
        return appState.isPackaged;
      },
      getAppPath: () => "/repo/clients/macos",
    },
  }),
);

// The mac helper's bundle folder name is per-environment, resolved from a
// sidecar file (with a plist-discovery walk as fallback) — see the module
// header. Defaults resolve `cadet-mac-helper.app`.
let helperExecutableName = "cadet-mac-helper";
let helperBundleName = "cadet-mac-helper";
mock.module("node:fs", () => ({
  existsSync: () => true,
  readdirSync: () => {
    throw new Error("directory walks are not exercised here");
  },
  readFileSync: (target: unknown) => {
    const targetPath = String(target);
    if (targetPath.endsWith(".cadet-mac-helper.bundle-name")) {
      return helperBundleName;
    }
    return `<plist><dict><key>CFBundleExecutable</key><string>${helperExecutableName}</string></dict></plist>`;
  },
}));

Object.defineProperty(process, "resourcesPath", {
  value: "/mock/resources",
  writable: true,
});

const { getMacHelperAppPath, getMacHelperPath } =
  await import("./native-helper-client");

beforeEach(() => {
  helperExecutableName = "cadet-mac-helper";
  helperBundleName = "cadet-mac-helper";
  appState.isPackaged = false;
});

describe("the mac helper path", () => {
  test("resolves dev helper app from app path resources", () => {
    expect(getMacHelperAppPath()).toBe(
      "/repo/clients/macos/resources/cadet-mac-helper.app",
    );
  });

  test("resolves dev helper from app path resources", () => {
    expect(getMacHelperPath()).toBe(
      "/repo/clients/macos/resources/cadet-mac-helper.app/Contents/MacOS/cadet-mac-helper",
    );
  });

  test("resolves packaged helper app from process.resourcesPath", () => {
    appState.isPackaged = true;
    expect(getMacHelperAppPath()).toBe(
      "/mock/resources/bin/cadet-mac-helper.app",
    );
  });

  test("resolves packaged helper from process.resourcesPath", () => {
    appState.isPackaged = true;
    expect(getMacHelperPath()).toBe(
      "/mock/resources/bin/cadet-mac-helper.app/Contents/MacOS/cadet-mac-helper",
    );
  });

  test("resolves the per-environment executable name from CFBundleExecutable", () => {
    helperExecutableName = "Cadet Helper Dev";
    expect(getMacHelperPath()).toBe(
      "/repo/clients/macos/resources/cadet-mac-helper.app/Contents/MacOS/Cadet Helper Dev",
    );
  });

  test("resolves the per-environment bundle folder name from the sidecar", () => {
    helperBundleName = "Cadet Helper Dev";
    expect(getMacHelperAppPath()).toBe(
      "/repo/clients/macos/resources/Cadet Helper Dev.app",
    );
    expect(getMacHelperPath()).toBe(
      "/repo/clients/macos/resources/Cadet Helper Dev.app/Contents/MacOS/cadet-mac-helper",
    );
  });

  test("resolves the packaged bundle folder name from the sidecar", () => {
    appState.isPackaged = true;
    helperBundleName = "Cadet Helper Staging";
    expect(getMacHelperAppPath()).toBe(
      "/mock/resources/bin/Cadet Helper Staging.app",
    );
  });
});
