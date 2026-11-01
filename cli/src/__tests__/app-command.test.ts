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

import * as tunnelLib from "../lib/tunnel.js";
import * as nginxIngress from "../lib/servers/nginx.js";
import * as localMode from "@mycadet/local-mode";

const ensureNginxForEdgeMock = mock(tunnelLib.ensureNginxForEdge);
const ensureAppServerMock = mock(nginxIngress.ensureAppServer);
const isIngressRunningMock = mock(localMode.isIngressRunning);
const readIngressStateMock = mock(localMode.readIngressState);
const stopIngressNginxMock = mock(localMode.stopIngressNginx);

mock.module("../lib/tunnel.js", () => ({
  ...tunnelLib,
  ensureNginxForEdge: ensureNginxForEdgeMock,
}));
mock.module("../lib/servers/nginx.js", () => ({
  ...nginxIngress,
  ensureAppServer: ensureAppServerMock,
}));
mock.module("@mycadet/local-mode", () => ({
  ...localMode,
  isIngressRunning: isIngressRunningMock,
  readIngressState: readIngressStateMock,
  stopIngressNginx: stopIngressNginxMock,
}));

afterAll(() => {
  mock.module("../lib/tunnel.js", () => tunnelLib);
  mock.module("../lib/servers/nginx.js", () => nginxIngress);
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
  ensureNginxForEdgeMock.mockReset();
  ensureNginxForEdgeMock.mockResolvedValue("nginx/1.26.3");
  ensureAppServerMock.mockReset();
  isIngressRunningMock.mockReset();
  isIngressRunningMock.mockReturnValue(false);
  readIngressStateMock.mockReset();
  stopIngressNginxMock.mockReset();
  stopIngressNginxMock.mockResolvedValue(true);
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
  test("start brings the edge up for the resolved local assistant", async () => {
    ensureAppServerMock.mockResolvedValue({ port: 7841, started: true });
    process.argv = ["bun", "cadet", "app", "start"];

    await app();

    expect(ensureNginxForEdgeMock).toHaveBeenCalled();
    expect(ensureAppServerMock).toHaveBeenCalledWith();
    expect(stdout.join("\n")).toContain(
      "Started the app edge on 127.0.0.1:7841",
    );
  });

  test("start reports a reused edge and the stop command", async () => {
    ensureAppServerMock.mockResolvedValue({ port: 7841, started: false });
    process.argv = ["bun", "cadet", "app", "start"];

    await app();

    const output = stdout.join("\n");
    expect(output).toContain("Reusing the app edge on 127.0.0.1:7841");
    expect(output).toContain("cadet app stop");
  });

  test("stop takes the running edge down", async () => {
    isIngressRunningMock.mockReturnValue(true);
    readIngressStateMock.mockReturnValue({
      listenPort: 7841,
      gatewayUrl: "http://127.0.0.1:7830",
    });
    process.argv = ["bun", "cadet", "app", "stop"];

    await app();

    expect(stopIngressNginxMock).toHaveBeenCalled();
    expect(stdout.join("\n")).toContain(
      "Stopped the app edge on 127.0.0.1:7841",
    );
  });

  test("stop with nothing running says so", async () => {
    isIngressRunningMock.mockReturnValue(false);
    process.argv = ["bun", "cadet", "app", "stop"];

    await app();

    expect(stopIngressNginxMock).not.toHaveBeenCalled();
    expect(stdout.join("\n")).toContain("No app edge is running.");
  });
});
