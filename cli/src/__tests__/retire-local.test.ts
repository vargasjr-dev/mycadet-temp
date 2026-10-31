import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeEntry, readLocalEntry } from "./helpers/lockfile-entry.js";

const testDir = mkdtempSync(join(tmpdir(), "retire-local-test-"));
const originalConfigHome = process.env.XDG_CONFIG_HOME;

// Snapshot the real modules before mocking so the module-scoped `afterAll`
// below can restore them. Bun runs every test file in one process with a
// shared loader, and `mock.restore()` does not undo `mock.module()`. Without
// restoring, the `retire-archive.js` mock in particular leaks its hardcoded
// `test-assistant.*` paths into sibling files (e.g. `recover.test.ts`), which
// then fail to find their own archives.
const realProcess = { ...(await import("../lib/process.js")) };
const realNginxIngress = { ...(await import("../lib/servers/nginx.js")) };
const realRetireArchive = { ...(await import("../lib/retire-archive.js")) };

const stopProcessByPidFileMock = mock(
  async (
    _pidFile: string,
    _label: string,
    _extraCleanupFiles?: string[],
    _timeoutMs?: number,
  ): Promise<boolean> => true,
);

const { DAEMON_STOP_TIMEOUT_MS } = realProcess;
const stopOrphanedDaemonProcessesMock = mock(
  async (_excludePids?: ReadonlySet<string>): Promise<boolean> => false,
);
const stopIngressNginxMock = mock(async (): Promise<boolean> => false);

mock.module("../lib/process.js", () => ({
  ...realProcess,
  stopProcessByPidFile: stopProcessByPidFileMock,
  stopOrphanedDaemonProcesses: stopOrphanedDaemonProcessesMock,
}));

mock.module("../lib/servers/nginx.js", () => ({
  stopIngressNginx: stopIngressNginxMock,
}));

// Keep archive paths on the same filesystem as the test dir so rename doesn't
// hit EXDEV (cross-device link).
const retiredStagingDir = join(testDir, "retired");
mock.module("../lib/retire-archive.js", () => ({
  getArchivePath: () => join(retiredStagingDir, "test-assistant.tar.gz"),
  getMetadataPath: () => join(retiredStagingDir, "test-assistant.meta.json"),
}));

// Restore the real modules once this file finishes so the mocks above do not
// leak into other test files in the same `bun test` run.
afterAll(() => {
  mock.module("../lib/process.js", () => realProcess);
  mock.module("../lib/servers/nginx.js", () => realNginxIngress);
  mock.module("../lib/retire-archive.js", () => realRetireArchive);
});

import { getRetireArchiveCommand, retireLocal } from "../lib/retire-local.js";

const instanceDir = join(testDir, "test-instance");

describe("retireLocal — CES sibling stop", () => {
  beforeAll(() => {
    process.env.XDG_CONFIG_HOME = testDir;
  });

  beforeEach(() => {
    stopProcessByPidFileMock.mockReset();
    stopProcessByPidFileMock.mockResolvedValue(true);
    stopOrphanedDaemonProcessesMock.mockReset();
    stopOrphanedDaemonProcessesMock.mockResolvedValue(false);
    stopIngressNginxMock.mockReset();
    stopIngressNginxMock.mockResolvedValue(false);

    rmSync(instanceDir, { recursive: true, force: true });
    rmSync(join(testDir, "retired"), { recursive: true, force: true });
    mkdirSync(instanceDir, { recursive: true });
    makeEntry({ assistantId: "test-assistant" });

    // Suppress console output from the lifecycle reporter.
    spyOn(console, "log").mockImplementation(() => {});
    spyOn(console, "warn").mockImplementation(() => {});
  });

  afterAll(() => {
    if (originalConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalConfigHome;
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  test("stops the CES sibling alongside daemon and gateway", async () => {
    makeEntry({
      assistantId: "test-assistant",
      instanceDir,
    });
    const entry = readLocalEntry("test-assistant");
    await retireLocal("test-assistant", entry, {
      progress: () => {},
      log: () => {},
      warn: () => {},
      error: () => {},
    });

    // Verify CES PID file is among the stop calls.
    const cesStopCall = stopProcessByPidFileMock.mock.calls.find(
      ([pidFile, label]) =>
        pidFile === join(instanceDir, "ces.pid") &&
        label === "credential-executor",
    );
    expect(cesStopCall).toBeDefined();

    // Also verify daemon and gateway are still stopped (sanity).
    const daemonStopCall = stopProcessByPidFileMock.mock.calls.find(
      ([, label]) => label === "daemon",
    );
    expect(daemonStopCall).toBeDefined();

    const gatewayStopCall = stopProcessByPidFileMock.mock.calls.find(
      ([, label]) => label === "gateway",
    );
    expect(gatewayStopCall).toBeDefined();
  });

  // The daemon stops its own worker processes (schedule, route host, resource
  // monitor, memory jobs) near the end of a long shutdown sequence. The 2s
  // default in stopProcess would SIGKILL it first, stranding those workers as
  // orphans that outlive the runtime that spawned them.
  test("gives the daemon its full stop budget, not the default grace", async () => {
    makeEntry({ assistantId: "test-assistant" });
    const entry = readLocalEntry("test-assistant");
    await retireLocal("test-assistant", entry, {
      progress: () => {},
      log: () => {},
      warn: () => {},
      error: () => {},
    });

    const daemonStopCall = stopProcessByPidFileMock.mock.calls.find(
      ([, label]) => label === "daemon",
    );
    expect(daemonStopCall?.[3]).toBe(DAEMON_STOP_TIMEOUT_MS);
    // The budget is only meaningful if it outlasts the daemon's own 30s
    // force-exit, which is what it is derived from. Anything at or below that
    // kills the daemon before it can fold the WAL and hand off on its way out.
    expect(DAEMON_STOP_TIMEOUT_MS).toBeGreaterThan(30_000);
  });

  test("CES stop is a no-op when ces.pid is absent", async () => {
    // stopProcessByPidFile returns false when the PID file doesn't exist.
    // retireLocal should still complete successfully — the CES stop is best-effort.
    stopProcessByPidFileMock.mockImplementation(
      async (pidFile: string): Promise<boolean> => {
        if (pidFile.includes("ces.pid")) return false;
        return true;
      },
    );

    makeEntry({
      assistantId: "test-assistant",
      instanceDir,
    });
    const entry = readLocalEntry("test-assistant");
    await retireLocal("test-assistant", entry, {
      progress: () => {},
      log: () => {},
      warn: () => {},
      error: () => {},
    });

    // The CES stop was attempted (PID file checked) but returned false.
    const cesStopCall = stopProcessByPidFileMock.mock.calls.find(
      ([pidFile, label]) =>
        pidFile === join(instanceDir, "ces.pid") &&
        label === "credential-executor",
    );
    expect(cesStopCall).toBeDefined();
  });
});

test("uses a Windows-native archive process", () => {
  const archivePath =
    "C:\\Users\\Example User\\Cadet\\retired\\assistant & data.tar.gz";
  const stagingDir = `${archivePath}.staging`;
  const archiveCommand = getRetireArchiveCommand(
    archivePath,
    stagingDir,
    "win32",
  );

  expect(archiveCommand.command).toBe("powershell.exe");
  expect(archiveCommand.args.join(" ")).toContain("tar.exe");
  expect(archiveCommand.args.join(" ")).not.toContain(archivePath);
  expect(archiveCommand.env).toMatchObject({
    CADET_RETIRE_ARCHIVE_PATH: archivePath,
    CADET_RETIRE_ARCHIVE_PARENT: "C:\\Users\\Example User\\Cadet\\retired",
    CADET_RETIRE_STAGING_NAME: "assistant & data.tar.gz.staging",
    CADET_RETIRE_STAGING_DIR: stagingDir,
  });
});
