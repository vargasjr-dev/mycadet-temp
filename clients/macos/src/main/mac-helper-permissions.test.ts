import { beforeEach, describe, expect, mock, test } from "bun:test";
import { writeFile } from "node:fs/promises";

import { electronMock } from "@mycadet/electron-desktop/test-setup";

import { FakeChild } from "./test-helpers";

mock.module("electron", () =>
  electronMock({
    app: {
      getAppPath: () => "/repo/clients/macos",
    },
  }),
);

// The permission launchers resolve the helper's (per-environment) bundle
// through the shared path resolver; the default sidecar/plist answers
// resolve `cadet-mac-helper.app`.
let helperBundleName = "cadet-mac-helper";
mock.module("node:fs", () => ({
  existsSync: () => true,
  readdirSync: () => {
    throw new Error("directory walks are not exercised here");
  },
  readFileSync: () => helperBundleName,
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
  helperBundleName = "cadet-mac-helper";
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
