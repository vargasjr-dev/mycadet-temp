import { beforeEach, describe, expect, mock, test } from "bun:test";

import { electronMock } from "../../test-setup";
import { FakeChild } from "../test-helpers";

mock.module("electron", () =>
  electronMock({
    app: {
      getAppPath: () => "/repo/clients/macos",
    },
  }),
);

// The launchers resolve the helper's (per-environment) bundle through the
// shared path resolver; the default sidecar/plist answers resolve
// `cadet-mac-helper.app`.
let helperBundleName = "cadet-mac-helper";
mock.module("node:fs", () => ({
  existsSync: () => true,
  readdirSync: () => {
    throw new Error("directory walks are not exercised here");
  },
  readFileSync: () => helperBundleName,
}));

// The fresh-status read goes through a temp file the helper writes.
mock.module("node:fs/promises", () => ({
  mkdtemp: async () => "/tmp/cadet-mac-helper-permission-fake",
  readFile: async () => '{"status":"granted"}',
  rm: async () => undefined,
}));

let lastChild: FakeChild | null = null;
const spawnCalls: Array<[string, string[]]> = [];
mock.module("node:child_process", () => ({
  spawn: (cmd: string, args: string[]) => {
    spawnCalls.push([cmd, args]);
    lastChild = new FakeChild();
    return lastChild;
  },
}));

mock.module("../../app-logger", () => ({
  getLogFilePaths: () => [],
  default: { info: () => undefined, warn: () => undefined },
}));

const { queryFreshHelperPermission, requestHelperPermission } =
  await import("./helper-permissions");

const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  spawnCalls.length = 0;
  lastChild = null;
  helperBundleName = "cadet-mac-helper";
});

describe("helper permission launchers", () => {
  test("reads a permission status from a fresh helper process", async () => {
    const pending = queryFreshHelperPermission("speechRecognition");
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

    lastChild?.emit("exit", 0);
    expect(await pending).toBe("granted");
  });

  test("launches the helper app for each permission prompt", async () => {
    const pending = requestHelperPermission("inputMonitoring");

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

  test("reports a failed launch as the launch error", async () => {
    const pending = requestHelperPermission("screen");
    lastChild?.emit("exit", 3);

    await expect(pending).rejects.toThrow("open exited with code 3");
  });
});
