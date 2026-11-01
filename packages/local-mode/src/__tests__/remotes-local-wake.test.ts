import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Snapshot the real modules before mocking so the module-scoped `afterAll`
// can restore them — bun runs every test file in one process with a shared
// loader, and `mock.restore()` does not undo `mock.module()`.
const realProcess = { ...(await import("../process")) };
const realCommon = { ...(await import("../remotes/local/common")) };
const realPorts = { ...(await import("../ports")) };
const realReadiness = { ...(await import("../daemon-readiness")) };

const probeDaemonReadinessWithRetryMock = mock<
  typeof realReadiness.probeDaemonReadinessWithRetry
>(async () => "ready");
const waitForDaemonMigrationsReadyMock = mock<
  typeof realReadiness.waitForDaemonMigrationsReady
>(async () => "ready");

mock.module("../daemon-readiness", () => ({
  ...realReadiness,
  probeDaemonReadinessWithRetry: probeDaemonReadinessWithRetryMock,
  waitForDaemonMigrationsReady: waitForDaemonMigrationsReadyMock,
}));

const resolveProcessStateMock = mock<typeof realProcess.resolveProcessState>(
  async (_pidFile, _port, label) => ({
    status: "healthy",
    pid: label === "Gateway" ? 456 : 123,
  }),
);
const stopProcessByPidFileMock = mock<typeof realProcess.stopProcessByPidFile>(
  async () => true,
);
const isProcessAliveMock = mock<typeof realProcess.isProcessAlive>(() => ({
  alive: false,
  pid: null,
}));

mock.module("../process", () => ({
  ...realProcess,
  resolveProcessState: resolveProcessStateMock,
  stopProcessByPidFile: stopProcessByPidFileMock,
  isProcessAlive: isProcessAliveMock,
}));

const findAvailablePortMock = mock<typeof realPorts.findAvailablePort>(
  async (port) => port,
);

mock.module("../ports", () => ({
  ...realPorts,
  findAvailablePort: findAvailablePortMock,
}));

const isAssistantWatchModeAvailableMock = mock<
  typeof realCommon.isAssistantWatchModeAvailable
>(() => false);
const isGatewayWatchModeAvailableMock = mock<
  typeof realCommon.isGatewayWatchModeAvailable
>(() => false);
const startLocalDaemonMock = mock<typeof realCommon.startLocalDaemon>(
  async () => {},
);
const startGatewayMock = mock<typeof realCommon.startGateway>(
  async () => "http://127.0.0.1:7830",
);
const startCesMock = mock<typeof realCommon.startCes>(async () => {});

mock.module("../remotes/local/common", () => ({
  ...realCommon,
  isAssistantWatchModeAvailable: isAssistantWatchModeAvailableMock,
  isGatewayWatchModeAvailable: isGatewayWatchModeAvailableMock,
  startLocalDaemon: startLocalDaemonMock,
  startGateway: startGatewayMock,
  startCes: startCesMock,
}));

afterAll(() => {
  mock.module("../process", () => realProcess);
  mock.module("../ports", () => realPorts);
  mock.module("../remotes/local/common", () => realCommon);
  mock.module("../daemon-readiness", () => realReadiness);
});

import type { LocalAssistant } from "../lockfile-contract";
import { wakeLocal } from "../remotes/local/wake";

let tempDir: string;
let logSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;
let localEntry: LocalAssistant;

// The daemon's pid file lives in the instance's workspace dir.
const daemonPidOf = (dir: string) => join(dir, "workspace", "cadet.pid");

function makeLocalEntry(): LocalAssistant {
  tempDir = mkdtempSync(join(tmpdir(), "cadet-wake-leg-test-"));
  // The identity lives in the instance's key file, not the lockfile.
  mkdirSync(join(tempDir, "gateway-security"), { recursive: true });
  writeFileSync(
    join(tempDir, "gateway-security", "actor-token-signing-key"),
    Buffer.from("ab".repeat(32), "hex"),
  );
  return {
    assistantId: "local-assistant",
    cloud: "local",
    instanceDir: tempDir,
    daemonPort: 7821,
    port: 7830,
    cesPort: 7822,
  };
}

beforeEach(() => {
  tempDir = "";
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});

  localEntry = makeLocalEntry();
  findAvailablePortMock.mockReset();
  findAvailablePortMock.mockImplementation(async (port) => port);
  resolveProcessStateMock.mockReset();
  resolveProcessStateMock.mockImplementation(
    async (_pidFile, _port, label) => ({
      status: "healthy",
      pid: label === "Gateway" ? 456 : 123,
    }),
  );
  stopProcessByPidFileMock.mockReset();
  stopProcessByPidFileMock.mockResolvedValue(true);
  isAssistantWatchModeAvailableMock.mockReset();
  isAssistantWatchModeAvailableMock.mockReturnValue(false);
  isGatewayWatchModeAvailableMock.mockReset();
  isGatewayWatchModeAvailableMock.mockReturnValue(false);
  startLocalDaemonMock.mockReset();
  startLocalDaemonMock.mockResolvedValue(undefined);
  startGatewayMock.mockReset();
  startGatewayMock.mockResolvedValue("http://127.0.0.1:7830");
  startCesMock.mockReset();
  startCesMock.mockResolvedValue(undefined);
  isProcessAliveMock.mockReset();
  isProcessAliveMock.mockReturnValue({ alive: false, pid: null });
  probeDaemonReadinessWithRetryMock.mockReset();
  probeDaemonReadinessWithRetryMock.mockResolvedValue("ready");
  waitForDaemonMigrationsReadyMock.mockReset();
  waitForDaemonMigrationsReadyMock.mockResolvedValue("ready");
});

afterEach(() => {
  logSpy.mockRestore();
  warnSpy.mockRestore();
});

describe("wakeLocal — the in-process local wake leg", () => {
  test("keeps a running gateway exactly as-is — no bootstrap-secret backfill", async () => {
    await wakeLocal(localEntry);

    expect(startGatewayMock).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Gateway already running"),
    );
  });

  test("relaunches CES sibling when daemon is healthy but CES is dead", async () => {
    // Daemon is healthy (default mock) but CES pid says dead.
    // isProcessAliveMock defaults to { alive: false }.
    await wakeLocal(localEntry);

    // startCes should be called to relaunch the dead sibling.
    expect(startCesMock).toHaveBeenCalledTimes(1);
    // startLocalDaemon should NOT be called (daemon already running).
    expect(startLocalDaemonMock).not.toHaveBeenCalled();
  });

  test("does NOT relaunch CES sibling when both daemon and CES are healthy", async () => {
    // Daemon is healthy (default mock). CES is also alive.
    isProcessAliveMock.mockReturnValue({ alive: true, pid: 789 });

    await wakeLocal(localEntry);

    // startCes should NOT be called (CES is alive).
    expect(startCesMock).not.toHaveBeenCalled();
    // startLocalDaemon should NOT be called (daemon already running).
    expect(startLocalDaemonMock).not.toHaveBeenCalled();
  });

  test("does not duplicate an assistant already classified as stuck", async () => {
    resolveProcessStateMock.mockImplementation(
      async (_pidFile, _port, label) =>
        label === "Assistant"
          ? { status: "stuck", pid: 123 }
          : { status: "healthy", pid: 456 },
    );

    await wakeLocal(localEntry);

    expect(startLocalDaemonMock).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("could not be stopped"),
    );
  });

  test("does not duplicate an assistant when a watch restart cannot stop it", async () => {
    isAssistantWatchModeAvailableMock.mockReturnValue(true);
    stopProcessByPidFileMock.mockResolvedValue(false);
    isProcessAliveMock.mockReturnValue({ alive: true, pid: 123 });

    await wakeLocal(localEntry, { watch: true });

    expect(startLocalDaemonMock).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("could not be stopped for watch mode"),
    );
  });

  test("does not duplicate a gateway already classified as stuck", async () => {
    resolveProcessStateMock.mockImplementation(
      async (_pidFile, _port, label) =>
        label === "Gateway"
          ? { status: "stuck", pid: 456 }
          : { status: "healthy", pid: 123 },
    );

    await wakeLocal(localEntry);

    expect(startGatewayMock).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Gateway running"),
    );
  });

  test("does not duplicate a gateway when a watch restart cannot stop it", async () => {
    isGatewayWatchModeAvailableMock.mockReturnValue(true);
    stopProcessByPidFileMock.mockResolvedValue(false);
    isProcessAliveMock.mockImplementation((pidFile) =>
      pidFile.endsWith("gateway.pid")
        ? { alive: true, pid: 456 }
        : { alive: false, pid: null },
    );

    await wakeLocal(localEntry, { watch: true });

    expect(startGatewayMock).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Gateway running"),
    );
  });
});

describe("wakeLocal — daemon startup failure", () => {
  beforeEach(() => {
    // The daemon needs starting; the gateway is already serving.
    resolveProcessStateMock.mockImplementation(
      async (_pidFile, _port, label) =>
        label === "Gateway"
          ? { status: "healthy", pid: 456 }
          : { status: "needs_start", pid: null },
    );
  });

  test("fails structured when the freshly spawned daemon is not running", async () => {
    /**
     * Tests that a daemon which aborts during startup (an occupied runtime
     * HTTP port) fails the wake instead of reporting a successful one.
     */

    // GIVEN the spawned daemon left no live process behind
    isProcessAliveMock.mockReturnValue({ alive: false, pid: null });

    // AND a foreign listener on the runtime HTTP port answers readiness in
    // the dead daemon's place
    // WHEN the leg runs
    const result = await wakeLocal(localEntry);

    // THEN the failure is structured, names the port, and never claims the
    // wake completed
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain(
      "exited during startup",
    );
    expect((result as { error: string }).error).toContain("7821");
    expect(logSpy).not.toHaveBeenCalledWith("Wake complete.");
    expect(startGatewayMock).not.toHaveBeenCalled();
  });

  test("completes when the freshly spawned daemon is running", async () => {
    /**
     * Tests that a healthy fresh spawn still reports a completed wake.
     */

    // GIVEN the spawned daemon is alive and ready
    isProcessAliveMock.mockImplementation((pidFile) =>
      pidFile === daemonPidOf(tempDir)
        ? { alive: true, pid: 123 }
        : { alive: false, pid: null },
    );

    // WHEN the leg runs
    await wakeLocal(localEntry);

    // THEN it reports success and starts the gateway
    expect(startLocalDaemonMock).toHaveBeenCalledTimes(1);
  });

  test("completes when the freshly spawned daemon is still migrating", async () => {
    /**
     * Tests that a live daemon running database migrations is reported as a
     * degraded success, not a failure.
     */

    // GIVEN the spawned daemon is alive but still migrating past the
    // gateway-coordination wait
    isProcessAliveMock.mockImplementation((pidFile) =>
      pidFile === daemonPidOf(tempDir)
        ? { alive: true, pid: 123 }
        : { alive: false, pid: null },
    );
    probeDaemonReadinessWithRetryMock.mockResolvedValue("migrating");
    waitForDaemonMigrationsReadyMock.mockResolvedValue("migrating");

    // WHEN the leg runs
    await wakeLocal(localEntry);

    // THEN it reports the migration state and completes
    expect(logSpy).toHaveBeenCalledWith(
      "Assistant is still running database migrations; DB-backed routes return 503 until they finish.",
    );
  });
});
