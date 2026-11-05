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
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Snapshot the real modules before mocking so the module-scoped `afterAll`
// can restore them — bun runs every test file in one process with a shared
// loader, and `mock.restore()` does not undo `mock.module()`.
const realProcess = { ...(await import("../process")) };
const realCommon = { ...(await import("../remotes/local/common")) };
const realPorts = { ...(await import("../ports")) };

const isProcessAliveMock = mock<typeof realProcess.isProcessAlive>(() => ({
  alive: false,
  pid: null,
}));

mock.module("../process", () => ({
  ...realProcess,
  isProcessAlive: isProcessAliveMock,
}));

const findAvailablePortMock = mock<typeof realPorts.findAvailablePort>(
  async (port) => port,
);

mock.module("../ports", () => ({
  ...realPorts,
  findAvailablePort: findAvailablePortMock,
}));

const startLocalDaemonMock = mock<typeof realCommon.startLocalDaemon>(
  async () => {},
);
const startGatewayMock = mock<typeof realCommon.startGateway>(
  async () => "http://127.0.0.1:7830",
);
const startCesMock = mock<typeof realCommon.startCes>(async () => {});

mock.module("../remotes/local/common", () => ({
  ...realCommon,
  startLocalDaemon: startLocalDaemonMock,
  startGateway: startGatewayMock,
  startCes: startCesMock,
}));

afterAll(() => {
  mock.module("../process", () => realProcess);
  mock.module("../ports", () => realPorts);
  mock.module("../remotes/local/common", () => realCommon);
});

import type { LocalAssistant } from "../lockfile-contract";
import { wakeLocal } from "../remotes/local/wake";

let tempDir: string;
let logSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;
let localEntry: LocalAssistant;

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
  startLocalDaemonMock.mockReset();
  startLocalDaemonMock.mockResolvedValue(undefined);
  startGatewayMock.mockReset();
  startGatewayMock.mockResolvedValue("http://127.0.0.1:7830");
  startCesMock.mockReset();
  startCesMock.mockResolvedValue(undefined);
  isProcessAliveMock.mockReset();
  isProcessAliveMock.mockReturnValue({ alive: true, pid: 123 });
});

afterEach(() => {
  logSpy.mockRestore();
  warnSpy.mockRestore();
});

describe("wakeLocal — the in-process local wake leg", () => {
  test("starts CES, the daemon, and the gateway — every wake, in parallel", async () => {
    /**
     * The wake asks no readiness questions and classifies no processes:
     * the start helpers own their own stale-process cleanup, and the
     * gateway owns readiness. Bring-up is one parallel step.
     */

    // GIVEN a previous wake already left everything running
    // WHEN the leg runs
    const result = await wakeLocal(localEntry);

    // THEN each sibling was started exactly once, all the same
    expect(startCesMock).toHaveBeenCalledTimes(1);
    expect(startLocalDaemonMock).toHaveBeenCalledTimes(1);
    expect(startGatewayMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true });
  });

  test("fails structured when the freshly spawned daemon is not running", async () => {
    /**
     * Tests that a daemon which aborts during startup (an occupied runtime
     * HTTP port) fails the wake instead of reporting a successful one.
     */

    // GIVEN the spawned daemon left no live process behind — whatever
    // foreign listener holds the port would answer the gateway's probes
    // in the dead daemon's place, so liveness is the signal
    isProcessAliveMock.mockReturnValue({ alive: false, pid: null });

    // WHEN the leg runs
    const result = await wakeLocal(localEntry);

    // THEN the failure is structured, names the port, and never claims the
    // wake completed
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain(
      "exited during startup",
    );
    expect((result as { error: string }).error).toContain("7821");
  });

  test("completes when the freshly spawned daemon is running", async () => {
    /**
     * Tests that a live fresh spawn reports a completed wake without the
     * wake itself tracking migrations — the gateway gates its own traffic
     * on the daemon's readiness.
     */

    // GIVEN the spawned daemon is alive
    // WHEN the leg runs
    const result = await wakeLocal(localEntry);

    // THEN it reports success
    expect(result).toEqual({ ok: true });
  });
});
