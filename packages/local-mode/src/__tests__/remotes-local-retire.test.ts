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

import { makeEntry, readLocalEntry } from "./helpers/lockfile-entry";

const testDir = mkdtempSync(join(tmpdir(), "retire-local-test-"));
const originalConfigHome = process.env.XDG_CONFIG_HOME;

// Snapshot the real modules before mocking so the module-scoped `afterAll`
// below can restore them. Bun runs every test file in one process with a
// shared loader, and `mock.restore()` does not undo `mock.module()`. Without
// restoring, the archive mock in particular leaks its hardcoded
// `test-assistant.*` paths into sibling files, which then fail to find their
// own archives.
const realProcess = { ...(await import("../process")) };
const realIngress = { ...(await import("../ingress")) };
const realArchive = { ...(await import("../remotes/local/archive")) };
const realLoopbackFetch = { ...(await import("../loopback-fetch")) };
const realCloudAuth = { ...(await import("../cloud-auth")) };

const stopProcessByPidFileMock = mock(
  async (
    _pidFile: string,
    _label: string,
    _extraCleanupFiles?: string[],
    _timeoutMs?: number,
  ): Promise<boolean> => true,
);

const { DAEMON_STOP_TIMEOUT_MS } = await import("../lifecycle-budgets");
const stopIngressNginxMock = mock(async (): Promise<boolean> => false);

mock.module("../process", () => ({
  ...realProcess,
  stopProcessByPidFile: stopProcessByPidFileMock,
}));

mock.module("../ingress", () => ({
  ...realIngress,
  stopIngressNginx: stopIngressNginxMock,
}));

// Keep archive paths on the same filesystem as the test dir so rename doesn't
// hit EXDEV (cross-device link).
const retiredStagingDir = join(testDir, "retired");
mock.module("../remotes/local/archive", () => ({
  ...realArchive,
  getArchivePath: () => join(retiredStagingDir, "test-assistant.tar.gz"),
  getMetadataPath: () => join(retiredStagingDir, "test-assistant.meta.json"),
}));

// The self-hosted platform unregister rides INSIDE retireLocal (the local
// retire leg owns it now), so the platform seams it dials are pinned here.
const loopbackSafeFetchMock = mock(
  async (): Promise<Response> => new Response(null, { status: 204 }),
);
const readCloudTokenMock = mock((): string | null => null);
const authHeadersForKnownOrganizationMock = mock(
  (token: string, organizationId: string) => ({
    "Content-Type": "application/json",
    "X-Session-Token": token,
    "Cadet-Organization-Id": organizationId,
  }),
);
const cloudAuthHeadersMock = mock(async () => ({
  "Content-Type": "application/json",
  "X-Session-Token": "session-token",
}));
const resolveCloudUrlMock = mock(() => "https://platform.example.test");

mock.module("../loopback-fetch", () => ({
  ...realLoopbackFetch,
  loopbackSafeFetch: loopbackSafeFetchMock,
}));
mock.module("../cloud-auth", () => ({
  ...realCloudAuth,
  readCloudToken: readCloudTokenMock,
  authHeadersForKnownOrganization: authHeadersForKnownOrganizationMock,
  cloudAuthHeaders: cloudAuthHeadersMock,
  resolveCloudUrl: resolveCloudUrlMock,
}));

// Restore the real modules once this file finishes so the mocks above do not
// leak into other test files in the same `bun test` run.
afterAll(() => {
  mock.module("../process", () => realProcess);
  mock.module("../ingress", () => realIngress);
  mock.module("../remotes/local/archive", () => realArchive);
  mock.module("../loopback-fetch", () => realLoopbackFetch);
  mock.module("../cloud-auth", () => realCloudAuth);
});

import { getRetireArchiveCommand, retireLocal } from "../remotes/local/retire";

const instanceDir = join(testDir, "test-instance");

describe("retireLocal — CES sibling stop", () => {
  beforeAll(() => {
    process.env.XDG_CONFIG_HOME = testDir;
  });

  beforeEach(() => {
    stopProcessByPidFileMock.mockReset();
    stopProcessByPidFileMock.mockResolvedValue(true);
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

describe("retireLocal — the self-hosted platform unregister", () => {
  const unregisterDir = mkdtempSync(join(tmpdir(), "retire-unregister-"));
  const silentReporter = {
    progress: () => {},
    log: () => {},
    warn: () => {},
    error: () => {},
  };

  beforeAll(() => {
    process.env.XDG_CONFIG_HOME = unregisterDir;
  });

  beforeEach(() => {
    loopbackSafeFetchMock.mockReset();
    loopbackSafeFetchMock.mockResolvedValue(
      new Response(null, { status: 204 }),
    );
    readCloudTokenMock.mockReset();
    readCloudTokenMock.mockReturnValue(null);
    cloudAuthHeadersMock.mockReset();
    cloudAuthHeadersMock.mockResolvedValue({
      "Content-Type": "application/json",
      "X-Session-Token": "session-token",
    });
    authHeadersForKnownOrganizationMock.mockReset();
    authHeadersForKnownOrganizationMock.mockImplementation(
      (token: string, organizationId: string) => ({
        "Content-Type": "application/json",
        "X-Session-Token": token,
        "Cadet-Organization-Id": organizationId,
      }),
    );
    resolveCloudUrlMock.mockReset();
    resolveCloudUrlMock.mockReturnValue("https://platform.example.test");
    delete process.env.CADET_CLOUD_TOKEN;
    delete process.env.CADET_PLATFORM_TOKEN;

    rmSync(join(unregisterDir, "retired"), { recursive: true, force: true });
  });

  afterAll(() => {
    delete process.env.CADET_CLOUD_TOKEN;
    delete process.env.CADET_PLATFORM_TOKEN;
    if (originalConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalConfigHome;
    }
    rmSync(unregisterDir, { recursive: true, force: true });
  });

  test("unregisters the cloud record straight from the lockfile entry", async () => {
    makeEntry({
      assistantId: "test-assistant",
      instanceDir: join(unregisterDir, "instance"),
      cloudAssistantId: "cloud-asst-1",
      cloudOrganizationId: "org-123",
    });
    readCloudTokenMock.mockReturnValue("session-token");
    const entry = readLocalEntry("test-assistant");

    await retireLocal("test-assistant", entry, silentReporter);

    // The cloud record resolves from the entry + env — no gateway credential
    // store is consulted.
    expect(loopbackSafeFetchMock).toHaveBeenCalledWith(
      "https://platform.example.test/v1/assistants/cloud-asst-1/retire/",
      {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          "X-Session-Token": "session-token",
          "Cadet-Organization-Id": "org-123",
        },
      },
    );
  });

  test("resolves the organization via the cloud when the entry omits it", async () => {
    makeEntry({
      assistantId: "test-assistant",
      instanceDir: join(unregisterDir, "instance"),
      cloudAssistantId: "cloud-asst-1",
    });
    readCloudTokenMock.mockReturnValue("session-token");
    const entry = readLocalEntry("test-assistant");

    await retireLocal("test-assistant", entry, silentReporter);

    expect(cloudAuthHeadersMock).toHaveBeenCalledWith(
      "session-token",
      "https://platform.example.test",
    );
    expect(authHeadersForKnownOrganizationMock).not.toHaveBeenCalled();
    expect(loopbackSafeFetchMock).toHaveBeenCalledWith(
      "https://platform.example.test/v1/assistants/cloud-asst-1/retire/",
      {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          "X-Session-Token": "session-token",
        },
      },
    );
  });

  test("skips the cloud unregister when no assistant id is bound", async () => {
    makeEntry({
      assistantId: "test-assistant",
      instanceDir: join(unregisterDir, "instance"),
    });
    readCloudTokenMock.mockReturnValue("session-token");
    const entry = readLocalEntry("test-assistant");

    await retireLocal("test-assistant", entry, silentReporter);

    expect(loopbackSafeFetchMock).not.toHaveBeenCalled();
  });

  test("uses the injected platform token from the app host", async () => {
    makeEntry({
      assistantId: "test-assistant",
      instanceDir: join(unregisterDir, "instance"),
      cloudAssistantId: "cloud-asst-1",
      cloudOrganizationId: "org-123",
    });
    process.env.CADET_PLATFORM_TOKEN = "host-session-token";
    readCloudTokenMock.mockReturnValue(null);
    const entry = readLocalEntry("test-assistant");

    await retireLocal("test-assistant", entry, silentReporter);

    expect(loopbackSafeFetchMock).toHaveBeenCalledWith(
      "https://platform.example.test/v1/assistants/cloud-asst-1/retire/",
      {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          "X-Session-Token": "host-session-token",
          "Cadet-Organization-Id": "org-123",
        },
      },
    );
  });

  test("continues the local teardown when the cloud unregister fails", async () => {
    makeEntry({
      assistantId: "test-assistant",
      instanceDir: join(unregisterDir, "instance"),
      cloudAssistantId: "cloud-asst-1",
      cloudOrganizationId: "org-123",
    });
    readCloudTokenMock.mockReturnValue("session-token");
    loopbackSafeFetchMock.mockResolvedValue(
      new Response("platform unavailable", { status: 503 }),
    );
    const entry = readLocalEntry("test-assistant");
    const warns: string[] = [];
    const warnSpy = spyOn(console, "warn").mockImplementation(
      (...args: unknown[]) => {
        warns.push(args.map(String).join(" "));
      },
    );

    try {
      await retireLocal("test-assistant", entry, silentReporter);
    } finally {
      warnSpy.mockRestore();
    }

    expect(warns.join("\n")).toContain(
      "Platform self-hosted unregister failed (503): platform unavailable",
    );
    expect(warns.join("\n")).toContain("continuing local retire");
  });
});
