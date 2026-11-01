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

import cliPkg from "../../package.json";
import { getLocalInstanceDir } from "../lib/remotes/local.js";
import type { LocalAssistant } from "@mycadet/local-mode/contract";
import * as assistantConfig from "../lib/assistant-config.js";
import * as localModeModule from "@mycadet/local-mode";
import * as backupOps from "../lib/backup-ops.js";
import type { GuardianTokenData } from "@mycadet/local-mode";
import * as guardianToken from "../lib/guardian-token.js";
import * as local from "../lib/remotes/local.js";
import * as loopbackFetch from "../lib/loopback-fetch.js";
import * as ngrok from "../lib/tunnels/ngrok.js";
import * as upgradeLifecycle from "../lib/upgrade-lifecycle.js";

const realAssistantConfig = { ...assistantConfig };
const realLocalMode = { ...localModeModule };
const realBackupOps = { ...backupOps };
const realGuardianToken = { ...guardianToken };
const realLocal = { ...local };
const realLoopbackFetch = { ...loopbackFetch };
const realNgrok = { ...ngrok };
const realUpgradeLifecycle = { ...upgradeLifecycle };

const findAssistantByNameMock =
  mock<typeof assistantConfig.findAssistantByName>();
const lookupAssistantByIdentifierMock =
  mock<typeof assistantConfig.lookupAssistantByIdentifier>();
const getActiveAssistantMock = mock<typeof assistantConfig.getActiveAssistant>(
  () => "local-assistant",
);
const loadAllAssistantsMock = mock<typeof assistantConfig.loadAllAssistants>(
  () => [],
);
const saveLockfileAssistantMock = mock<
  typeof localModeModule.saveLockfileAssistant
>(() => ({ ok: true, lockfile: { assistants: [], activeAssistant: null } }));

mock.module("@mycadet/local-mode", () => ({
  ...realLocalMode,
  saveLockfileAssistant: saveLockfileAssistantMock,
}));

mock.module("../lib/assistant-config", () => ({
  ...realAssistantConfig,
  findAssistantByName: findAssistantByNameMock,
  lookupAssistantByIdentifier: lookupAssistantByIdentifierMock,
  getActiveAssistant: getActiveAssistantMock,
  loadAllAssistants: loadAllAssistantsMock,
}));

const createBackupMock = mock<typeof backupOps.createBackup>(
  async () => "/tmp/local-pre-upgrade.tar.gz",
);
const pruneOldBackupsMock = mock<typeof backupOps.pruneOldBackups>(() => {});
const restoreBackupMock = mock<typeof backupOps.restoreBackup>(
  async () => true,
);

mock.module("../lib/backup-ops.js", () => ({
  ...realBackupOps,
  createBackup: createBackupMock,
  pruneOldBackups: pruneOldBackupsMock,
  restoreBackup: restoreBackupMock,
}));

function makeGuardianToken(
  overrides: Partial<GuardianTokenData> = {},
): GuardianTokenData {
  const now = Date.now();
  return {
    guardianPrincipalId: "guardian-principal",
    accessToken: "access-token",
    accessTokenExpiresAt: new Date(now + 60_000).toISOString(),
    refreshToken: "refresh-token",
    refreshTokenExpiresAt: new Date(now + 3_600_000).toISOString(),
    refreshAfter: new Date(now + 30_000).toISOString(),
    isNew: false,
    deviceId: "device-id",
    leasedAt: new Date(now).toISOString(),
    ...overrides,
  };
}

const bootstrapSecrets = new Map<string, string>();
const saveGuardianBootstrapSecret = (id: string, secret: string) => {
  bootstrapSecrets.set(id, secret);
};
const loadGuardianBootstrapSecret = (id: string) => bootstrapSecrets.get(id);
const leaseGuardianTokenMock = mock<typeof guardianToken.leaseGuardianToken>(
  async () => makeGuardianToken({ isNew: true }),
);
const resetGuardianBootstrapMock = mock<
  typeof guardianToken.resetGuardianBootstrap
>(async () => {});

mock.module("../lib/guardian-token.js", () => ({
  ...realGuardianToken,
  leaseGuardianToken: leaseGuardianTokenMock,
  resetGuardianBootstrap: resetGuardianBootstrapMock,
  saveGuardianBootstrapSecret,
  loadGuardianBootstrapSecret,
}));

const generateLocalSecretMock = mock<typeof local.generateLocalSecret>(
  () => "generated-local-secret",
);
const ensureLocalRuntimeMock = mock<typeof local.ensureLocalRuntime>(
  (resources, version) => ({
    version,
    installDir: join(getLocalInstanceDir(resources), "runtime", version),
  }),
);
const startLocalDaemonMock = mock<typeof local.startLocalDaemon>(
  async () => {},
);
const startGatewayMock = mock<typeof local.startGateway>(
  async () => "http://127.0.0.1:7830",
);
const stopLocalProcessesMock = mock<typeof local.stopLocalProcesses>(
  async () => {},
);
const startCesMock = mock<typeof local.startCes>(async () => {});

mock.module("../lib/remotes/local.js", () => ({
  ...realLocal,
  generateLocalSigningKey: generateLocalSecretMock,
  ensureLocalRuntime: ensureLocalRuntimeMock,
  startLocalDaemon: startLocalDaemonMock,
  startGateway: startGatewayMock,
  stopLocalProcesses: stopLocalProcessesMock,
  startCes: startCesMock,
}));

const loopbackSafeFetchMock = mock<typeof loopbackFetch.loopbackSafeFetch>(
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

mock.module("../lib/loopback-fetch.js", () => ({
  ...realLoopbackFetch,
  loopbackSafeFetch: loopbackSafeFetchMock,
}));

const runNgrokTunnelMock = mock<typeof ngrok.runNgrokTunnel>(async () => {
  return {
    publicUrl: "https://tunnel.example.com",
    waitForExit: Promise.resolve(),
  } as never;
});

mock.module("../lib/tunnels/ngrok.js", () => ({
  ...realNgrok,
  runNgrokTunnel: runNgrokTunnelMock,
  NGROK_PROVIDER: {
    ...realNgrok.NGROK_PROVIDER,
    run: runNgrokTunnelMock,
  },
}));

const broadcastUpgradeEventMock = mock<
  typeof upgradeLifecycle.broadcastUpgradeEvent
>(async () => {});
const commitWorkspaceViaGatewayMock = mock<
  typeof upgradeLifecycle.commitWorkspaceViaGateway
>(async () => {});
const waitForReadyMock = mock<typeof upgradeLifecycle.waitForReady>(
  async () => true,
);

mock.module("../lib/upgrade-lifecycle.js", () => ({
  ...realUpgradeLifecycle,
  broadcastUpgradeEvent: broadcastUpgradeEventMock,
  commitWorkspaceViaGateway: commitWorkspaceViaGatewayMock,
  waitForReady: waitForReadyMock,
}));

const { targetVersionFromCli, upgrade } =
  await import("../commands/upgrade.js");

let tempDir: string;
let originalArgv: string[];
let consoleLogSpy: ReturnType<typeof spyOn>;
let consoleWarnSpy: ReturnType<typeof spyOn>;
let consoleErrorSpy: ReturnType<typeof spyOn>;
let exitSpy: ReturnType<typeof spyOn>;

function makeLocalEntry(): LocalAssistant {
  tempDir = mkdtempSync(join(tmpdir(), "cadet-upgrade-local-test-"));
  // The identity lives in the instance's key file, not the lockfile.
  mkdirSync(join(tempDir, "gateway-security"), { recursive: true });
  writeFileSync(
    join(tempDir, "gateway-security", "actor-token-signing-key"),
    Buffer.from("ab".repeat(32), "hex"),
  );
  saveGuardianBootstrapSecret("local-assistant", "existing-bootstrap-secret");
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
  originalArgv = [...process.argv];
  tempDir = "";
  assistantConfig.stampRootProcess("tunnel", {
    pid: 4321,
    provider: "ngrok",
    startedAt: new Date().toISOString(),
    // The record's `publicUrl` is the restore's gate: a published run comes
    // back after the upgrade.
    publicUrl: "https://tunnel.example.com",
  });
  process.argv = [
    "bun",
    "cadet",
    "upgrade",
    "local-assistant",
    "--version",
    cliPkg.version ? `v${cliPkg.version}` : "v0.8.12",
  ];

  consoleLogSpy = spyOn(console, "log").mockImplementation(() => {});
  consoleWarnSpy = spyOn(console, "warn").mockImplementation(() => {});
  consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
  exitSpy = spyOn(process, "exit").mockImplementation((code?: number) => {
    throw new Error(`process.exit(${code})`);
  });

  const entry = makeLocalEntry();
  findAssistantByNameMock.mockReset();
  findAssistantByNameMock.mockReturnValue(entry);
  lookupAssistantByIdentifierMock.mockReset();
  lookupAssistantByIdentifierMock.mockReturnValue({ status: "found", entry });
  getActiveAssistantMock.mockReset();
  getActiveAssistantMock.mockReturnValue("local-assistant");
  loadAllAssistantsMock.mockReset();
  loadAllAssistantsMock.mockReturnValue([entry]);
  saveLockfileAssistantMock.mockReset();
  saveLockfileAssistantMock.mockImplementation(() => ({
    ok: true,
    lockfile: { assistants: [], activeAssistant: null },
  }));
  createBackupMock.mockReset();
  createBackupMock.mockResolvedValue("/tmp/local-pre-upgrade.tar.gz");
  pruneOldBackupsMock.mockReset();
  pruneOldBackupsMock.mockReturnValue(undefined);
  restoreBackupMock.mockReset();
  restoreBackupMock.mockResolvedValue(true);
  leaseGuardianTokenMock.mockReset();
  leaseGuardianTokenMock.mockResolvedValue(makeGuardianToken({ isNew: true }));
  resetGuardianBootstrapMock.mockReset();
  resetGuardianBootstrapMock.mockResolvedValue(undefined);
  generateLocalSecretMock.mockReset();
  generateLocalSecretMock.mockReturnValue("generated-local-secret");
  ensureLocalRuntimeMock.mockReset();
  ensureLocalRuntimeMock.mockImplementation((resources, version) => ({
    version,
    installDir: join(getLocalInstanceDir(resources), "runtime", version),
  }));
  startLocalDaemonMock.mockReset();
  startLocalDaemonMock.mockResolvedValue(undefined);
  startGatewayMock.mockReset();
  startGatewayMock.mockResolvedValue("http://127.0.0.1:7830");
  stopLocalProcessesMock.mockReset();
  stopLocalProcessesMock.mockResolvedValue(undefined);
  startCesMock.mockReset();
  startCesMock.mockResolvedValue(undefined);
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
  runNgrokTunnelMock.mockReset();
  runNgrokTunnelMock.mockImplementation(
    async () =>
      ({
        publicUrl: "https://tunnel.example.com",
        waitForExit: Promise.resolve(),
      }) as never,
  );
  broadcastUpgradeEventMock.mockReset();
  broadcastUpgradeEventMock.mockResolvedValue(undefined);
  commitWorkspaceViaGatewayMock.mockReset();
  commitWorkspaceViaGatewayMock.mockResolvedValue(undefined);
  waitForReadyMock.mockReset();
  waitForReadyMock.mockResolvedValue(true);
});

afterEach(() => {
  process.argv = originalArgv;
  consoleLogSpy.mockRestore();
  consoleWarnSpy.mockRestore();
  consoleErrorSpy.mockRestore();
  exitSpy.mockRestore();
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

afterAll(() => {
  mock.module("@mycadet/local-mode", () => realLocalMode);
  mock.module("../lib/assistant-config", () => realAssistantConfig);
  mock.module("../lib/backup-ops.js", () => realBackupOps);
  mock.module("../lib/guardian-token.js", () => realGuardianToken);
  mock.module("../lib/remotes/local.js", () => realLocal);
  mock.module("../lib/loopback-fetch.js", () => realLoopbackFetch);
  mock.module("../lib/tunnels/ngrok.js", () => realNgrok);
  mock.module("../lib/upgrade-lifecycle.js", () => realUpgradeLifecycle);
});

describe("cadet upgrade local", () => {
  test("uses explicit target versions as-is", async () => {
    const resolveLatest = mock(async () => "v0.9.9");

    await expect(
      targetVersionFromCli(
        "v0.8.12",
        "0.10.0-local.20260622155324.21c18fa3b3",
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
        resolveLatest,
      ),
    ).resolves.toBe("v0.9.9");
    expect(resolveLatest).toHaveBeenCalledTimes(1);
  });

  test("defaults published CLI builds to the CLI version", async () => {
    const resolveLatest = mock(async () => "v0.9.9");

    await expect(
      targetVersionFromCli(null, "0.10.0", resolveLatest),
    ).resolves.toBe("v0.10.0");
    expect(resolveLatest).not.toHaveBeenCalled();
  });

  test("defaults local CLI builds to the latest stable runtime", async () => {
    const resolveLatest = mock(async () => "v0.9.9");

    await expect(
      targetVersionFromCli(
        null,
        "0.10.0-local.20260622155324.21c18fa3b3",
        resolveLatest,
      ),
    ).resolves.toBe("v0.9.9");
    expect(resolveLatest).toHaveBeenCalledTimes(1);
  });

  test("restarts local assistant processes and records upgrade lifecycle", async () => {
    await upgrade();

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
    expect(stopLocalProcessesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceDir: tempDir,
        runtimeVersion: cliPkg.version ? `v${cliPkg.version}` : "v0.8.12",
      }),
    );
    expect(ensureLocalRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({ instanceDir: tempDir }),
      cliPkg.version ? `v${cliPkg.version}` : "v0.8.12",
      { force: false },
    );
    expect(startLocalDaemonMock).toHaveBeenCalledWith(
      false,
      expect.objectContaining({
        instanceDir: tempDir,
        runtimeVersion: cliPkg.version ? `v${cliPkg.version}` : "v0.8.12",
      }),
    );
    expect(startGatewayMock).toHaveBeenCalledWith(
      false,
      expect.objectContaining({
        instanceDir: tempDir,
        runtimeVersion: cliPkg.version ? `v${cliPkg.version}` : "v0.8.12",
      }),
      {
        bootstrapSecret: "existing-bootstrap-secret",
      },
    );
    expect(resetGuardianBootstrapMock).toHaveBeenCalledWith(
      "http://127.0.0.1:7830",
      "existing-bootstrap-secret",
    );
    expect(leaseGuardianTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantId: "local-assistant",
      }),
    );
    // The recorded tunnel re-establishes only when the app server it fronts
    // is restored; this fixture records no edge, so nothing tunnels here
    // (the restore-with-edge coverage lives in the wake and tunnel suites).
    expect(runNgrokTunnelMock).not.toHaveBeenCalled();
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
    await upgrade();
    expect(consoleWarnSpy.mock.calls.flat().join("\n")).toContain(
      "continuing WITHOUT a backup",
    );
    expect(pruneOldBackupsMock).not.toHaveBeenCalled();
    expect(restoreBackupMock).not.toHaveBeenCalled();
    expect(ensureLocalRuntimeMock).toHaveBeenCalled();
    expect(startLocalDaemonMock).toHaveBeenCalled();
  });

  test("failed target startup restores prior runtime selection and all roots before restarting", async () => {
    startLocalDaemonMock.mockRejectedValueOnce(
      new Error("target startup failed"),
    );
    await expect(upgrade()).rejects.toThrow("process.exit(1)");
    expect(restoreBackupMock).toHaveBeenCalledWith(
      "local-assistant",
      "/tmp/local-pre-upgrade.tar.gz",
      { resume: false },
    );
    expect(startLocalDaemonMock).toHaveBeenCalledTimes(2);
    expect(startCesMock).toHaveBeenCalledTimes(2);
    expect(stopLocalProcessesMock).toHaveBeenCalledTimes(2);
    expect(waitForReadyMock).toHaveBeenCalled();
  });

  test("skips restart when the local assistant is already on the target version", async () => {
    loopbackSafeFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        version: cliPkg.version ? `v${cliPkg.version}` : "v0.8.12",
      }),
    } as Response);

    await upgrade();

    expect(stopLocalProcessesMock).not.toHaveBeenCalled();
    expect(ensureLocalRuntimeMock).not.toHaveBeenCalled();
    expect(startLocalDaemonMock).not.toHaveBeenCalled();
    expect(startGatewayMock).not.toHaveBeenCalled();
    expect(consoleLogSpy.mock.calls.flat().join("\n")).toContain("Already on");
  });
});

// `cli/AGENTS.md` § "Assistant targeting convention": exact assistant ID
// matches win over display-name matches; a unique display-name match
// resolves to its assistant; an ambiguous display name is an error listing
// the matching IDs. That precedence lives in, and is tested directly against,
// `lookupAssistantByIdentifier` (see assistant-config.test.ts). These tests
// only check `cadet upgrade`'s wiring: each one stubs the exact result
// (found/ambiguous) the shared helper would return for a given argument, and
// asserts the command acts on it correctly, without reimplementing the
// lookup rules themselves.
describe("cadet upgrade assistant targeting", () => {
  function makeQuillEntry(
    overrides: Partial<LocalAssistant> = {},
  ): LocalAssistant {
    return {
      ...makeLocalEntry(),
      assistantId: "quill-uuid",
      name: "Quill",
      ...overrides,
    };
  }

  function argvFor(...positional: string[]): string[] {
    return [
      "bun",
      "cadet",
      "upgrade",
      ...positional,
      "--version",
      cliPkg.version ? `v${cliPkg.version}` : "v0.8.12",
    ];
  }

  test("resolves a unique display-name match to its assistant", async () => {
    const quill = makeQuillEntry();
    process.argv = argvFor("Quill");
    lookupAssistantByIdentifierMock.mockReturnValue({
      status: "found",
      entry: quill,
    });

    await upgrade();

    expect(lookupAssistantByIdentifierMock).toHaveBeenCalledWith("Quill");
    expect(exitSpy).not.toHaveBeenCalled();
    expect(stopLocalProcessesMock).toHaveBeenCalledWith(
      expect.objectContaining({ instanceDir: quill.instanceDir }),
    );
  });

  test("resolves a multi-word display-name argument, unsplit by --version", async () => {
    const multiWord = makeQuillEntry({ name: "My Assistant" });
    process.argv = argvFor("My", "Assistant");
    lookupAssistantByIdentifierMock.mockReturnValue({
      status: "found",
      entry: multiWord,
    });

    await upgrade();

    expect(lookupAssistantByIdentifierMock).toHaveBeenCalledWith(
      "My Assistant",
    );
    expect(exitSpy).not.toHaveBeenCalled();
    expect(stopLocalProcessesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceDir: multiWord.instanceDir,
      }),
    );
  });

  test("an exact assistant-ID argument resolves via the shared helper's found result", async () => {
    // `lookupAssistantByIdentifier` owns ID-wins-over-name precedence
    // (covered in assistant-config.test.ts); this only checks that
    // `cadet upgrade` passes the raw argument through unmodified and acts
    // on whatever entry the shared helper resolves.
    const target = makeQuillEntry({ assistantId: "quill-uuid" });
    process.argv = argvFor("quill-uuid");
    lookupAssistantByIdentifierMock.mockReturnValue({
      status: "found",
      entry: target,
    });

    await upgrade();

    expect(lookupAssistantByIdentifierMock).toHaveBeenCalledWith("quill-uuid");
    expect(exitSpy).not.toHaveBeenCalled();
    expect(stopLocalProcessesMock).toHaveBeenCalledWith(
      expect.objectContaining({ instanceDir: target.instanceDir }),
    );
  });

  test("an ambiguous display name fails and lists the matching IDs", async () => {
    process.argv = argvFor("Quill");
    lookupAssistantByIdentifierMock.mockReturnValue({
      status: "ambiguous",
      matches: [
        makeQuillEntry({ assistantId: "quill-uuid-1" }),
        makeQuillEntry({ assistantId: "quill-uuid-2" }),
      ],
    });

    await expect(upgrade()).rejects.toThrow("process.exit(1)");

    expect(stopLocalProcessesMock).not.toHaveBeenCalled();
    const errText = consoleErrorSpy.mock.calls.flat().join("\n");
    expect(errText).toContain("Multiple assistants match 'Quill'");
    expect(errText).toContain("quill-uuid-1");
    expect(errText).toContain("quill-uuid-2");
  });
});
