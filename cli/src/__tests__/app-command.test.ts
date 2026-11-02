import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Mocks — the app command's collaborators are process-boundary fakes; the
// real modules restore when this file finishes so nothing leaks into
// sibling suites in the same `bun test` run.
// ---------------------------------------------------------------------------

import * as serversLib from "../lib/servers/app-server.js";
import * as localMode from "@mycadet/local-mode";

const ensureAppServerMock = mock(serversLib.ensureAppServer);
const isAppServerRunningMock = mock(localMode.isAppServerRunning);
const readAppServerStateMock = mock(localMode.readAppServerState);
const stopAppServerMock = mock(localMode.stopAppServer);

mock.module("../lib/servers/app-server.js", () => ({
  ...serversLib,
  ensureAppServer: ensureAppServerMock,
}));
mock.module("@mycadet/local-mode", () => ({
  ...localMode,
  isAppServerRunning: isAppServerRunningMock,
  readAppServerState: readAppServerStateMock,
  stopAppServer: stopAppServerMock,
}));

afterAll(() => {
  mock.module("../lib/servers/app-server.js", () => serversLib);
  mock.module("@mycadet/local-mode", () => localMode);
});

import { app } from "../commands/app.js";

// The default-workspace dir is real; the lockfile read inside the command's
// workspace sweep stays hermetic under a redirected lockfile dir.
const testDir = mkdtempSync(join(tmpdir(), "cli-app-command-test-"));
const originalConfigHome = process.env.XDG_CONFIG_HOME;
process.env.XDG_CONFIG_HOME = testDir;

const originalArgv = process.argv;
let stdout: string[];
let originalLog: typeof console.log;

beforeEach(() => {
  stdout = [];
  originalLog = console.log;
  console.log = (...args: unknown[]) => {
    stdout.push(args.map((a) => String(a)).join(" "));
  };
  ensureAppServerMock.mockReset();
  isAppServerRunningMock.mockReset();
  isAppServerRunningMock.mockReturnValue(false);
  readAppServerStateMock.mockReset();
  stopAppServerMock.mockReset();
  stopAppServerMock.mockResolvedValue(true);
});

afterEach(() => {
  console.log = originalLog;
  process.argv = originalArgv;
});

afterAll(() => {
  if (originalConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = originalConfigHome;
  }
  rmSync(testDir, { recursive: true, force: true });
});

describe("cadet app", () => {
  test("start brings the app server up for the resolved local assistant", async () => {
    ensureAppServerMock.mockResolvedValue({ port: 7841, started: true });
    process.argv = ["bun", "cadet", "app", "start"];

    await app();

    expect(ensureAppServerMock).toHaveBeenCalledWith();
    expect(stdout.join("\n")).toContain(
      "Started the app server on 127.0.0.1:7841",
    );
  });

  test("start reports a reused server and the stop command", async () => {
    ensureAppServerMock.mockResolvedValue({ port: 7841, started: false });
    process.argv = ["bun", "cadet", "app", "start"];

    await app();

    const output = stdout.join("\n");
    expect(output).toContain("Reusing the app server on 127.0.0.1:7841");
    expect(output).toContain("cadet app stop");
  });

  test("stop takes the running server down", async () => {
    isAppServerRunningMock.mockReturnValue(true);
    readAppServerStateMock.mockReturnValue({
      listenPort: 7841,
      gatewayUrl: "http://127.0.0.1:7830",
    });
    process.argv = ["bun", "cadet", "app", "stop"];

    await app();

    expect(stopAppServerMock).toHaveBeenCalled();
    expect(stdout.join("\n")).toContain(
      "Stopped the app server on 127.0.0.1:7841",
    );
  });

  test("stop with nothing running says so", async () => {
    isAppServerRunningMock.mockReturnValue(false);
    process.argv = ["bun", "cadet", "app", "stop"];

    await app();

    expect(stopAppServerMock).not.toHaveBeenCalled();
    expect(stdout.join("\n")).toContain("No app server is running.");
  });
});
