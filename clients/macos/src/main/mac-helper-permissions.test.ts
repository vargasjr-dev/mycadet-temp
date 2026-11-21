import { beforeEach, describe, expect, mock, test } from "bun:test";
import { writeFile } from "node:fs/promises";

import { electronMock } from "@mycadet/electron-desktop/test-setup";

import { FakeChild } from "./test-helpers";

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

let exists = true;
// getMacHelperPath reads CFBundleExecutable from the bundle's Info.plist;
// getMacHelperAppPath reads a sidecar (.cadet-mac-helper.bundle-name) for
// the .app folder name. Defaults resolve `cadet-mac-helper.app`.
let helperExecutableName = "cadet-mac-helper";
let helperBundleName = "cadet-mac-helper";
mock.module("node:fs", () => ({
  existsSync: () => exists,
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

let lastChild: FakeChild | null = null;
const spawnCalls: Array<[string, string[], object]> = [];
mock.module("node:child_process", () => ({
  spawn: (cmd: string, args: string[], opts: object) => {
    spawnCalls.push([cmd, args, opts]);
    lastChild = new FakeChild();
    return lastChild;
  },
}));

mock.module("@mycadet/electron-desktop/app-logger", () => ({
  getLogFilePaths: () => [],
  default: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
  },
}));

Object.defineProperty(process, "resourcesPath", {
  value: "/mock/resources",
  writable: true,
});

const { getMacHelperAppPath, getMacHelperPath } =
  await import("./sidecar/mac-helper-path");

const {
  queryFreshMacHelperPermission,
  requestMacHelperInputMonitoringPermission,
  requestMacHelperSpeechRecognitionPermission,
} = await import("./mac-helper-permissions");

const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  spawnCalls.length = 0;
  lastChild = null;
  exists = true;
  helperExecutableName = "cadet-mac-helper";
  helperBundleName = "cadet-mac-helper";
  appState.isPackaged = false;
});

describe("getMacHelperPath", () => {
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

describe("permission request launchers", () => {
  test("reads a permission status from a fresh helper process", async () => {
    const pending = queryFreshMacHelperPermission("speechRecognition");
    await wait(10);

    expect(spawnCalls[0]?.[0]).toBe("open");
    const args = spawnCalls[0]?.[1] ?? [];
    expect(args.slice(0, 4)).toEqual([
      "-n",
      "/repo/clients/macos/resources/cadet-mac-helper.app",
      "--args",
      "--permission-status",
    ]);
    expect(args[4]).toBe("speechRecognition");
    expect(args[5]).toBe("--status-output");
    expect(args[6]).toBeString();

    await writeFile(args[6]!, '{"status":"granted"}');
    lastChild?.emit("exit", 0);
    expect(await pending).toBe("granted");
  });

  test("launches the helper app for Speech Recognition prompts", async () => {
    const pending = requestMacHelperSpeechRecognitionPermission();

    expect(spawnCalls[0]?.[0]).toBe("open");
    expect(spawnCalls[0]?.[1]).toEqual([
      "-n",
      "/repo/clients/macos/resources/cadet-mac-helper.app",
      "--args",
      "--request-speech-recognition",
    ]);

    lastChild?.emit("exit", 0);
    await expect(pending).resolves.toBeUndefined();
  });

  test("launches the helper app for Input Monitoring prompts", async () => {
    const pending = requestMacHelperInputMonitoringPermission();

    expect(spawnCalls[0]?.[0]).toBe("open");
    expect(spawnCalls[0]?.[1]).toEqual([
      "-n",
      "/repo/clients/macos/resources/cadet-mac-helper.app",
      "--args",
      "--request-input-monitoring",
    ]);

    lastChild?.emit("exit", 0);
    await expect(pending).resolves.toBeUndefined();
  });
});
