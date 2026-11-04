/**
 * The local upgrade leg: the runtime swap on this machine. The command-side
 * targeting ceremony lives in the CLI's upgrade-local.test; this file pins
 * the leg's own contract — version targeting, the backup/restart/lease
 * sequence, and the rollback-on-failed-start recovery.
 */
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

import { getLocalInstanceDir } from "..";
import type { LocalAssistant } from "../lockfile-contract";
import * as sleepModule from "../operations/sleep";
import * as wakeModule from "../operations/wake";
import * as commonModule from "../remotes/local/common";
import * as guardianModule from "../guardian-token";
import * as loopbackModule from "../loopback-fetch";
import * as lifecycle from "../upgrade-lifecycle";
import * as backups from "../backup-ops";
import { consoleLifecycleReporter } from "../lifecycle-reporter";
import { targetVersionFromCli, upgradeLocal } from "../remotes/local/upgrade";

const realSleep = { ...sleepModule };
const realWake = { ...wakeModule };
const realCommon = { ...commonModule };
const realGuardian = { ...guardianModule };
const realLoopback = { ...loopbackModule };
const realLifecycle = { ...lifecycle };
const realBackups = { ...backups };

const createBackupMock = mock<typeof backups.createBackup>(
  async () => "/tmp/local-pre-upgrade.tar.gz",
);
const pruneOldBackupsMock = mock<typeof backups.pruneOldBackups>(() => {});
const restoreBackupMock = mock<typeof backups.restoreBackup>(async () => true);

mock.module("../backup-ops", () => ({
  ...realBackups,
  createBackup: createBackupMock,
  pruneOldBackups: pruneOldBackupsMock,
  restoreBackup: restoreBackupMock,
}));

function makeGuardianToken() {
  const now = Date.now();
  return {
    guardianPrincipalId: "guardian-principal",
    accessToken: "access-token",
    accessTokenExpiresAt: new Date(now + 60_000).toISOString(),
    refreshToken: "refresh-token",
    refreshTokenExpiresAt: new Date(now + 3_600_000).toISOString(),
    refreshAfter: new Date(now + 30_000).toISOString(),
    deviceId: "device-id",
    leasedAt: new Date(now).toISOString(),
  };
}

const leaseGuardianTokenMock = mock<typeof guardianModule.leaseGuardianToken>(
  async () => makeGuardianToken(),
);

mock.module("../guardian-token", () => ({
  ...realGuardian,
  leaseGuardianToken: leaseGuardianTokenMock,
}));

const ensureLocalRuntimeMock = mock<typeof commonModule.ensureLocalRuntime>(
  (resources, version) => ({
    version,
    installDir: join(getLocalInstanceDir(resources), "runtime", version),
  }),
);

mock.module("../remotes/local/common", () => ({
  ...realCommon,
  ensureLocalRuntime: ensureLocalRuntimeMock,
}));

const sleepAssistantMock = mock<typeof sleepModule.sleepAssistant>(
  async () => ({
    ok: true,
    kind: "services",
    services: {
      assistant: "stopped",
      gateway: "stopped",
      ces: "stopped",
    },
    notes: [],
    wasRunning: false,
  }),
);
const wakeAssistantMock = mock<typeof wakeModule.wakeAssistant>(async () => ({
  ok: true,
}));

mock.module("../operations/sleep", () => ({
  ...realSleep,
  sleepAssistant: sleepAssistantMock,
}));
mock.module("../operations/wake", () => ({
  ...realWake,
  wakeAssistant: wakeAssistantMock,
}));

const loopbackSafeFetchMock = mock<typeof loopbackModule.loopbackSafeFetch>(
  async () =>
    ({
      ok: true,
      json: async () => ({
        version: "v0.8.11",
        migrations: {
          dbVersion: 12,
          lastWorkspaceMigrationId: "011-test",
        },
      }),
    }) as Response,
);

mock.module("../loopback-fetch", () => ({
  ...realLoopback,
  loopbackSafeFetch: loopbackSafeFetchMock,
}));

const broadcastUpgradeEventMock = mock<typeof lifecycle.broadcastUpgradeEvent>(
  async () => {},
);
const commitWorkspaceViaGatewayMock = mock<
  typeof lifecycle.commitWorkspaceViaGateway
>(async () => {});
const waitForReadyMock = mock<typeof lifecycle.waitForReady>(async () => true);

mock.module("../upgrade-lifecycle", () => ({
  ...realLifecycle,
  broadcastUpgradeEvent: broadcastUpgradeEventMock,
  commitWorkspaceViaGateway: commitWorkspaceViaGatewayMock,
  waitForReady: waitForReadyMock,
}));

let tempDir: string;
let consoleLogSpy: ReturnType<typeof spyOn>;
let consoleWarnSpy: ReturnType<typeof spyOn>;
let consoleErrorSpy: ReturnType<typeof spyOn>;

function makeLocalEntry(): LocalAssistant {
  tempDir = mkdtempSync(join(tmpdir(), "cadet-upgrade-local-test-"));
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

const CLI_VERSION = "0.8.12";
const TARGET = "v0.8.12";

/** Drive the leg the way the CLI's command does for an explicit version. */
function runLeg() {
  const entry = makeLocalEntry();
  return upgradeLocal({
    entry,
    version: TARGET,
    cliVersion: CLI_VERSION,
    force: false,
    reporter: consoleLifecycleReporter,
  });
}

beforeEach(() => {
  tempDir = "";
  consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
  consoleWarnSpy = spyOn(console, "warn").mockImplementation(() => {});
  consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
  createBackupMock.mockReset();
  createBackupMock.mockResolvedValue("/tmp/local-pre-upgrade.tar.gz");
  pruneOldBackupsMock.mockReset();
  pruneOldBackupsMock.mockReturnValue(undefined);
  restoreBackupMock.mockReset();
  restoreBackupMock.mockResolvedValue(true);
  leaseGuardianTokenMock.mockReset();
  leaseGuardianTokenMock.mockResolvedValue(makeGuardianToken());
  ensureLocalRuntimeMock.mockReset();
  ensureLocalRuntimeMock.mockImplementation((resources, version) => ({
    version,
    installDir: join(getLocalInstanceDir(resources), "runtime", version),
  }));
  sleepAssistantMock.mockReset();
  sleepAssistantMock.mockResolvedValue({
    ok: true,
    kind: "services",
    services: { assistant: "stopped", gateway: "stopped", ces: "stopped" },
    notes: [],
    wasRunning: false,
  });
  wakeAssistantMock.mockReset();
  wakeAssistantMock.mockResolvedValue({ ok: true });
  loopbackSafeFetchMock.mockReset();
  loopbackSafeFetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({
      version: "v0.8.11",
      migrations: {
        dbVersion: 12,
        lastWorkspaceMigrationId: "011-test",
      },
    }),
  } as Response);
  broadcastUpgradeEventMock.mockReset();
  broadcastUpgradeEventMock.mockResolvedValue(undefined);
  commitWorkspaceViaGatewayMock.mockReset();
  commitWorkspaceViaGatewayMock.mockResolvedValue(undefined);
  waitForReadyMock.mockReset();
  waitForReadyMock.mockResolvedValue(true);
});

afterEach(() => {
  consoleLogSpy.mockRestore();
  consoleWarnSpy.mockRestore();
  consoleErrorSpy.mockRestore();
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

afterAll(() => {
  mock.module("../backup-ops", () => realBackups);
  mock.module("../guardian-token", () => realGuardian);
  mock.module("../remotes/local/common", () => realCommon);
  mock.module("../operations/sleep", () => realSleep);
  mock.module("../operations/wake", () => realWake);
  mock.module("../loopback-fetch", () => realLoopback);
  mock.module("../upgrade-lifecycle", () => realLifecycle);
});

describe("targetVersionFromCli", () => {
  test("uses explicit target versions as-is", async () => {
    const resolveLatest = mock(async () => "v0.9.9");

    await expect(
      targetVersionFromCli(
        "v0.8.12",
        "0.10.0-local.20260622155324.21c18fa3b3",
        consoleLifecycleReporter,
        resolveLatest,
      ),
    ).resolves.toBe("v0.8.12");
    expect(resolveLatest).not.toHaveBeenCalled();
  });

  test("resolves explicit local build targets to the latest stable runtime", async () => {
    const resolveLatest = mock(async () => "v0.9.9");

    await expect(
      targetVersionFromCli(
        "0.10.0-local.20260622155324.21c18fa3b3",
        "0.10.0",
        consoleLifecycleReporter,
        resolveLatest,
      ),
    ).resolves.toBe("v0.9.9");
    expect(resolveLatest).toHaveBeenCalledTimes(1);
  });

  test("defaults published CLI builds to the CLI version", async () => {
    const resolveLatest = mock(async () => "v0.9.9");

    await expect(
      targetVersionFromCli(
        null,
        "0.10.0",
        consoleLifecycleReporter,
        resolveLatest,
      ),
    ).resolves.toBe("v0.10.0");
    expect(resolveLatest).not.toHaveBeenCalled();
  });

  test("defaults local CLI builds to the latest stable runtime", async () => {
    const resolveLatest = mock(async () => "v0.9.9");

    await expect(
      targetVersionFromCli(
        null,
        "0.10.0-local.20260622155324.21c18fa3b3",
        consoleLifecycleReporter,
        resolveLatest,
      ),
    ).resolves.toBe("v0.9.9");
    expect(resolveLatest).toHaveBeenCalledTimes(1);
  });
});

describe("upgradeLocal", () => {
  test("restarts local assistant processes and records upgrade lifecycle", async () => {
    await runLeg();

    expect(loopbackSafeFetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:7830/healthz",
      expect.any(Object),
    );
    expect(createBackupMock).toHaveBeenCalledWith(
      "local-assistant",
      expect.objectContaining({
        prefix: "local-assistant-pre-upgrade",
      }),
    );
    expect(sleepAssistantMock).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceDir: tempDir,
      }),
      { force: true },
    );
    expect(ensureLocalRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({ instanceDir: tempDir }),
      TARGET,
      { force: false },
    );
    expect(wakeAssistantMock).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceDir: tempDir,
      }),
    );
    expect(leaseGuardianTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantId: "local-assistant",
      }),
    );
    expect(waitForReadyMock).toHaveBeenCalledWith("http://127.0.0.1:7830");
    expect(commitWorkspaceViaGatewayMock).toHaveBeenCalledWith(
      "http://127.0.0.1:7830",
      "local-assistant",
      expect.stringContaining("topology: local"),
    );
    expect(consoleLogSpy.mock.calls.flat().join("\n")).toContain("upgraded to");
  });

  test("failed safety backup continues the upgrade without one", async () => {
    createBackupMock.mockResolvedValue(null);
    await runLeg();
    expect(consoleWarnSpy.mock.calls.flat().join("\n")).toContain(
      "continuing WITHOUT a backup",
    );
    expect(pruneOldBackupsMock).not.toHaveBeenCalled();
    expect(restoreBackupMock).not.toHaveBeenCalled();
    expect(ensureLocalRuntimeMock).toHaveBeenCalled();
    expect(wakeAssistantMock).toHaveBeenCalled();
  });

  test("failed target startup restores prior runtime selection and all roots before restarting", async () => {
    wakeAssistantMock.mockRejectedValueOnce(new Error("target startup failed"));
    await expect(runLeg()).rejects.toThrow("target startup failed");
    expect(restoreBackupMock).toHaveBeenCalledWith(
      "local-assistant",
      "/tmp/local-pre-upgrade.tar.gz",
      { resume: false },
    );
    expect(wakeAssistantMock).toHaveBeenCalledTimes(2);
    expect(sleepAssistantMock).toHaveBeenCalledTimes(2);
    expect(waitForReadyMock).toHaveBeenCalled();
  });

  test("skips restart when the local assistant is already on the target version", async () => {
    loopbackSafeFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ version: TARGET }),
    } as Response);

    await runLeg();

    expect(sleepAssistantMock).not.toHaveBeenCalled();
    expect(ensureLocalRuntimeMock).not.toHaveBeenCalled();
    expect(consoleLogSpy.mock.calls.flat().join("\n")).toContain("Already on");
  });
});
