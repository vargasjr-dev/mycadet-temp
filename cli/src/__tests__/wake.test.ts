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
import { resolveExistingLocalSigningKey } from "@mycadet/local-mode";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as assistantConfig from "../lib/assistant-config.js";
import * as docker from "../lib/docker.js";
import * as guardianToken from "../lib/guardian-token.js";
import * as httpClient from "../lib/http-client.js";
import * as ingressConfig from "../lib/ingress-config.js";
import * as local from "../lib/local.js";
import * as nginxIngress from "../lib/nginx-ingress.js";
import * as ngrok from "../lib/tunnels/ngrok.js";
import * as processLib from "../lib/process.js";
import * as portAllocator from "../lib/port-allocator.js";
import * as rootSigningKey from "../lib/root-signing-key.js";
import type { LockfileAssistant } from "../lib/assistant-config.js";
import { makeGuardianTokenData } from "./helpers/guardian-token.js";

const realAssistantConfig = { ...assistantConfig };
const realDocker = { ...docker };
const realGuardianToken = { ...guardianToken };
const realLocal = { ...local };
const realNgrok = { ...ngrok };
const realProcessLib = { ...processLib };
const realPortAllocator = { ...portAllocator };
const realRootSigningKey = { ...rootSigningKey };

const resolveTargetAssistantMock =
  mock<typeof assistantConfig.resolveTargetAssistant>();
const loadAllAssistantsMock = mock<typeof assistantConfig.loadAllAssistants>(
  () => [],
);
const loadAllAssistantsAcrossEnvsMock = mock<
  typeof assistantConfig.loadAllAssistantsAcrossEnvs
>(() => []);
const saveLockfileAssistantMock = mock<
  typeof assistantConfig.saveLockfileAssistant
>(() => {});
const getDaemonPidPathMock = mock<typeof assistantConfig.getDaemonPidPath>(
  (resources) => join(resources?.instanceDir ?? "missing", "daemon.pid"),
);

mock.module("../lib/assistant-config.js", () => ({
  ...realAssistantConfig,
  resolveTargetAssistant: resolveTargetAssistantMock,
  loadAllAssistants: loadAllAssistantsMock,
  loadAllAssistantsAcrossEnvs: loadAllAssistantsAcrossEnvsMock,
  saveLockfileAssistant: saveLockfileAssistantMock,
  getDaemonPidPath: getDaemonPidPathMock,
}));

const dockerResourceNamesMock = mock<typeof docker.dockerResourceNames>(
  realDocker.dockerResourceNames,
);
const wakeContainersMock = mock<typeof docker.wakeContainers>(async () => {});
const recreateDockerContainersMock = mock<
  typeof docker.recreateDockerContainers
>(async () => {});

mock.module("../lib/docker.js", () => ({
  ...realDocker,
  dockerResourceNames: dockerResourceNamesMock,
  wakeContainers: wakeContainersMock,
  recreateDockerContainers: recreateDockerContainersMock,
}));

const seedGuardianTokenFromSiblingEnvMock = mock<
  typeof guardianToken.seedGuardianTokenFromSiblingEnv
>(() => false);
// Default: a token exists, so the re-provision recovery path is skipped. Tests
// that exercise recovery override loadGuardianToken to return null.
const loadGuardianTokenMock = mock<typeof guardianToken.loadGuardianToken>(() =>
  makeGuardianTokenData({ accessToken: "existing" }),
);
const resetGuardianBootstrapMock = mock<
  typeof guardianToken.resetGuardianBootstrap
>(async () => {});
const leaseGuardianTokenMock = mock<typeof guardianToken.leaseGuardianToken>(
  async () => makeGuardianTokenData(),
);

mock.module("../lib/guardian-token.js", () => ({
  ...realGuardianToken,
  seedGuardianTokenFromSiblingEnv: seedGuardianTokenFromSiblingEnvMock,
  loadGuardianToken: loadGuardianTokenMock,
  resetGuardianBootstrap: resetGuardianBootstrapMock,
  leaseGuardianToken: leaseGuardianTokenMock,
}));

const resolveProcessStateMock = mock<typeof processLib.resolveProcessState>(
  async (_pidFile, _port, label) => ({
    status: "healthy",
    pid: label === "Gateway" ? 456 : 123,
  }),
);
const stopProcessByPidFileMock = mock<typeof processLib.stopProcessByPidFile>(
  async () => true,
);
const isProcessAliveMock = mock<typeof processLib.isProcessAlive>(() => ({
  alive: false,
  pid: null,
}));

mock.module("../lib/process", () => ({
  ...realProcessLib,
  resolveProcessState: resolveProcessStateMock,
  stopProcessByPidFile: stopProcessByPidFileMock,
  isProcessAlive: isProcessAliveMock,
}));

const findOpenPortMock = mock<typeof portAllocator.findOpenPort>(
  async (port) => port,
);

mock.module("../lib/port-allocator.js", () => ({
  ...realPortAllocator,
  findOpenPort: findOpenPortMock,
}));

// Defaults to the real writer: repair tests assert the key file's contents.
const persistRootSigningKeyMock = mock<
  typeof rootSigningKey.persistRootSigningKey
>(realRootSigningKey.persistRootSigningKey);

mock.module("../lib/root-signing-key.js", () => ({
  ...realRootSigningKey,
  persistRootSigningKey: persistRootSigningKeyMock,
}));

const generateLocalSigningKeyMock = mock<typeof local.generateLocalSigningKey>(
  () => "generated-bootstrap-secret",
);
const isAssistantWatchModeAvailableMock = mock<
  typeof local.isAssistantWatchModeAvailable
>(() => false);
const isGatewayWatchModeAvailableMock = mock<
  typeof local.isGatewayWatchModeAvailable
>(() => false);
const startLocalDaemonMock = mock<typeof local.startLocalDaemon>(
  async () => {},
);
const startGatewayMock = mock<typeof local.startGateway>(
  async () => "http://127.0.0.1:7830",
);
const startCesMock = mock<typeof local.startCes>(async () => {});

mock.module("../lib/local", () => ({
  ...realLocal,
  generateLocalSigningKey: generateLocalSigningKeyMock,
  isAssistantWatchModeAvailable: isAssistantWatchModeAvailableMock,
  isGatewayWatchModeAvailable: isGatewayWatchModeAvailableMock,
  startLocalDaemon: startLocalDaemonMock,
  startGateway: startGatewayMock,
  startCes: startCesMock,
}));

const ngrokStartMock = mock<
  (opts: {
    port: number;
    workspaceDir: string;
    assistantId?: string;
  }) => Promise<string | null>
>(async () => null);

mock.module("../lib/tunnels/ngrok", () => ({
  ...realNgrok,
  NGROK_PROVIDER: {
    ...realNgrok.NGROK_PROVIDER,
    start: ngrokStartMock,
  },
}));

const realIngressConfig = { ...ingressConfig };
const realNginxIngress = { ...nginxIngress };

const loadRawConfigMock = mock<typeof ingressConfig.loadRawConfig>(() => ({}));

mock.module("../lib/ingress-config.js", () => ({
  ...realIngressConfig,
  loadRawConfig: loadRawConfigMock,
}));

const ensureAppServerMock = mock<typeof nginxIngress.ensureAppServer>(
  async () => ({ port: 7840, started: true, shellMode: "web" }),
);
const isIngressRunningMock = mock<typeof nginxIngress.isIngressRunning>(
  () => false,
);
const readIngressStateMock = mock<typeof nginxIngress.readIngressState>(
  () => null,
);

mock.module("../lib/nginx-ingress.js", () => ({
  ...realNginxIngress,
  ensureAppServer: ensureAppServerMock,
  isIngressRunning: isIngressRunningMock,
  readIngressState: readIngressStateMock,
}));

const realHttpClient = { ...httpClient };

const probeDaemonReadinessWithRetryMock = mock<
  typeof httpClient.probeDaemonReadinessWithRetry
>(async () => "ready");
const waitForDaemonMigrationsReadyMock = mock<
  typeof httpClient.waitForDaemonMigrationsReady
>(async () => "ready");
const waitForDaemonReadyMock = mock<typeof httpClient.waitForDaemonReady>(
  async () => true,
);

mock.module("../lib/http-client.js", () => ({
  ...realHttpClient,
  probeDaemonReadinessWithRetry: probeDaemonReadinessWithRetryMock,
  waitForDaemonMigrationsReady: waitForDaemonMigrationsReadyMock,
  waitForDaemonReady: waitForDaemonReadyMock,
}));

const { wake } = await import("../commands/wake.js");

let tempDir: string;
let originalArgv: string[];
let logSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;
let errorSpy: ReturnType<typeof spyOn>;
let localEntry: LockfileAssistant;

function makeLocalEntry(): LockfileAssistant {
  tempDir = mkdtempSync(join(tmpdir(), "cadet-wake-test-"));
  // The identity lives in the instance's key file, not the lockfile.
  mkdirSync(join(tempDir, "gateway-security"), { recursive: true });
  writeFileSync(
    join(tempDir, "gateway-security", "actor-token-signing-key"),
    Buffer.from("ab".repeat(32), "hex"),
  );
  return {
    assistantId: "local-assistant",
    runtimeUrl: "http://127.0.0.1:7830",
    cloud: "local",
    resources: {
      instanceDir: tempDir,
      daemonPort: 7821,
      gatewayPort: 7830,
      cesPort: 7822,
    },
  };
}

const keyFilePath = () =>
  join(tempDir, "gateway-security", "actor-token-signing-key");
const readKeyFile = (): string => readFileSync(keyFilePath()).toString("hex");
const removeIdentity = (): void => {
  rmSync(keyFilePath(), { force: true });
  rmSync(join(tempDir, "workspace", "deprecated", "actor-token-signing-key"), {
    force: true,
  });
};

beforeEach(() => {
  originalArgv = [...process.argv];
  tempDir = "";
  process.argv = ["bun", "cadet", "wake", "--watch", "local-assistant"];
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = spyOn(console, "error").mockImplementation(() => {});

  localEntry = makeLocalEntry();
  resolveTargetAssistantMock.mockReset();
  resolveTargetAssistantMock.mockReturnValue(localEntry);
  loadAllAssistantsMock.mockReset();
  loadAllAssistantsMock.mockReturnValue([]);
  loadAllAssistantsAcrossEnvsMock.mockReset();
  loadAllAssistantsAcrossEnvsMock.mockReturnValue([]);
  saveLockfileAssistantMock.mockReset();
  getDaemonPidPathMock.mockReset();
  getDaemonPidPathMock.mockImplementation((resources) =>
    join(resources?.instanceDir ?? "missing", "daemon.pid"),
  );
  resolveProcessStateMock.mockReset();
  resolveProcessStateMock.mockImplementation(
    async (_pidFile, _port, label) => ({
      status: "healthy",
      pid: label === "Gateway" ? 456 : 123,
    }),
  );
  stopProcessByPidFileMock.mockReset();
  stopProcessByPidFileMock.mockResolvedValue(true);
  findOpenPortMock.mockReset();
  findOpenPortMock.mockImplementation(async (port) => port);
  generateLocalSigningKeyMock.mockReset();
  generateLocalSigningKeyMock.mockReturnValue("generated-bootstrap-secret");
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
  persistRootSigningKeyMock.mockReset();
  persistRootSigningKeyMock.mockImplementation(
    realRootSigningKey.persistRootSigningKey,
  );
  probeDaemonReadinessWithRetryMock.mockReset();
  probeDaemonReadinessWithRetryMock.mockResolvedValue("ready");
  waitForDaemonMigrationsReadyMock.mockReset();
  waitForDaemonMigrationsReadyMock.mockImplementation(async () => "ready");
  waitForDaemonReadyMock.mockReset();
  waitForDaemonReadyMock.mockImplementation(async () => true);
  waitForDaemonMigrationsReadyMock.mockResolvedValue("ready");
  seedGuardianTokenFromSiblingEnvMock.mockReset();
  seedGuardianTokenFromSiblingEnvMock.mockReturnValue(false);
  loadGuardianTokenMock.mockReset();
  loadGuardianTokenMock.mockReturnValue(
    makeGuardianTokenData({ accessToken: "existing" }),
  );
  resetGuardianBootstrapMock.mockReset();
  resetGuardianBootstrapMock.mockResolvedValue(undefined);
  leaseGuardianTokenMock.mockReset();
  leaseGuardianTokenMock.mockResolvedValue(makeGuardianTokenData());
  ngrokStartMock.mockReset();
  ngrokStartMock.mockResolvedValue(null);
  loadRawConfigMock.mockReset();
  loadRawConfigMock.mockReturnValue({});
  ensureAppServerMock.mockReset();
  ensureAppServerMock.mockResolvedValue({
    port: 7840,
    started: true,
  });
  isIngressRunningMock.mockReset();
  isIngressRunningMock.mockReturnValue(false);
  readIngressStateMock.mockReset();
  readIngressStateMock.mockReturnValue(null);
});

afterEach(() => {
  process.argv = originalArgv;
  logSpy.mockRestore();
  warnSpy.mockRestore();
  errorSpy.mockRestore();
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

afterAll(() => {
  mock.module("../lib/assistant-config.js", () => realAssistantConfig);
  mock.module("../lib/docker.js", () => realDocker);
  mock.module("../lib/guardian-token.js", () => realGuardianToken);
  mock.module("../lib/process", () => realProcessLib);
  mock.module("../lib/port-allocator.js", () => realPortAllocator);
  mock.module("../lib/local", () => realLocal);
  mock.module("../lib/tunnels/ngrok", () => realNgrok);
  mock.module("../lib/ingress-config.js", () => realIngressConfig);
  mock.module("../lib/nginx-ingress.js", () => realNginxIngress);
  mock.module("../lib/http-client.js", () => realHttpClient);
  // TEMP-REMOVED
});

describe("cadet wake", () => {
  test("missing identity refuses before probing, stopping, starting, or repairing", async () => {
    rmSync(join(tempDir, "gateway-security", "actor-token-signing-key"));
    await expect(wake()).rejects.toThrow(
      /signing key missing.*cadet wake.*--repair-guardian/,
    );
    expect(resolveProcessStateMock).not.toHaveBeenCalled();
    expect(stopProcessByPidFileMock).not.toHaveBeenCalled();
    expect(startLocalDaemonMock).not.toHaveBeenCalled();
    expect(startGatewayMock).not.toHaveBeenCalled();
    expect(generateLocalSigningKeyMock).not.toHaveBeenCalled();
    expect(resetGuardianBootstrapMock).not.toHaveBeenCalled();
    expect(saveLockfileAssistantMock).not.toHaveBeenCalled();
  });

  test("recovers the existing deprecated key before process startup", async () => {
    removeIdentity();
    localEntry.guardianBootstrapSecret = "existing-bootstrap";
    const dir = join(tempDir, "workspace", "deprecated");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "actor-token-signing-key"),
      Buffer.from("cd".repeat(32), "hex"),
    );
    process.argv = ["bun", "cadet", "wake", "local-assistant"];
    resolveProcessStateMock.mockImplementation(async () => {
      // The deprecated file is a read-only source — nothing converges it.
      expect(existsSync(keyFilePath())).toBe(false);
      return { status: "needs_start", pid: null };
    });
    isProcessAliveMock.mockReturnValue({ alive: true, pid: 123 });
    await wake();
    expect(startLocalDaemonMock).toHaveBeenCalledWith(
      false,
      localEntry.resources,
      { foreground: false, signingKey: "cd".repeat(32) },
    );
    expect(startGatewayMock).toHaveBeenCalledWith(false, localEntry.resources, {
      signingKey: "cd".repeat(32),
      bootstrapSecret: "existing-bootstrap",
    });
    expect(generateLocalSigningKeyMock).not.toHaveBeenCalled();
    expect(resetGuardianBootstrapMock).not.toHaveBeenCalled();
    expect(leaseGuardianTokenMock).not.toHaveBeenCalled();
  });

  test("a conflicting key refuses before any process is stopped", async () => {
    const legacy = join(tempDir, "workspace", "deprecated");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(
      join(legacy, "actor-token-signing-key"),
      Buffer.from("ab".repeat(32), "hex"),
    );
    const dir = join(tempDir, "gateway-security");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "actor-token-signing-key"),
      Buffer.from("cd".repeat(32), "hex"),
    );
    await expect(wake()).rejects.toThrow("signing key conflict");
    expect(resolveProcessStateMock).not.toHaveBeenCalled();
    expect(stopProcessByPidFileMock).not.toHaveBeenCalled();
    expect(saveLockfileAssistantMock).not.toHaveBeenCalled();
  });

  for (const failure of [
    "missing",
    "invalid",
    "conflict",
    "unreadable",
  ] as const) {
    test(`explicit repair recovers ${failure} identity and the next ordinary wake reuses it`, async () => {
      removeIdentity();
      localEntry.guardianBootstrapSecret = "existing-bootstrap";
      const protectedDir = join(tempDir, "gateway-security");
      const legacyDir = join(tempDir, "workspace", "deprecated");
      if (failure === "invalid")
        writeFileSync(keyFilePath(), Buffer.from("bad-key"));
      if (failure === "unreadable")
        mkdirSync(join(protectedDir, "actor-token-signing-key"), {
          recursive: true,
        });
      if (failure === "conflict") {
        mkdirSync(protectedDir, { recursive: true });
        mkdirSync(legacyDir, { recursive: true });
        writeFileSync(
          join(protectedDir, "actor-token-signing-key"),
          Buffer.from("ab".repeat(32), "hex"),
        );
        writeFileSync(
          join(legacyDir, "actor-token-signing-key"),
          Buffer.from("cd".repeat(32), "hex"),
        );
      }
      process.argv = [
        "bun",
        "cadet",
        "wake",
        "local-assistant",
        "--repair-guardian",
      ];
      const replacement = "ef".repeat(32);
      generateLocalSigningKeyMock.mockReturnValue(replacement);
      resolveProcessStateMock.mockImplementation(async () => {
        expect(readKeyFile()).toBe(replacement);
        expect(stopProcessByPidFileMock).toHaveBeenCalledTimes(2);
        return { status: "needs_start", pid: null };
      });
      isProcessAliveMock.mockReturnValue({ alive: true, pid: 123 });
      await wake();
      expect(startLocalDaemonMock).toHaveBeenCalledWith(
        false,
        localEntry.resources,
        { foreground: false, signingKey: replacement },
      );
      expect(startGatewayMock).toHaveBeenCalledWith(
        false,
        localEntry.resources,
        { signingKey: replacement, bootstrapSecret: "existing-bootstrap" },
      );
      expect(resetGuardianBootstrapMock).toHaveBeenCalledTimes(1);
      expect(leaseGuardianTokenMock).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls.flat().join(" ")).toContain(
        "all clients must authenticate again",
      );
      expect(resolveExistingLocalSigningKey(localEntry.resources)).toBe(
        replacement,
      );
      process.argv = ["bun", "cadet", "wake", "local-assistant"];
      generateLocalSigningKeyMock.mockClear();
      resetGuardianBootstrapMock.mockClear();
      leaseGuardianTokenMock.mockClear();
      await wake();
      expect(generateLocalSigningKeyMock).not.toHaveBeenCalled();
      expect(resetGuardianBootstrapMock).not.toHaveBeenCalled();
      expect(leaseGuardianTokenMock).not.toHaveBeenCalled();
    });
  }

  test("explicit repair preserves a recoverable key without restarting healthy services", async () => {
    localEntry.guardianBootstrapSecret = "existing-bootstrap";
    process.argv = [
      "bun",
      "cadet",
      "wake",
      "local-assistant",
      "--repair-guardian",
    ];
    isProcessAliveMock.mockReturnValue({ alive: true, pid: 123 });
    await wake();
    expect(findOpenPortMock).not.toHaveBeenCalled();
    expect(generateLocalSigningKeyMock).not.toHaveBeenCalled();
    expect(stopProcessByPidFileMock).not.toHaveBeenCalled();
    expect(startLocalDaemonMock).not.toHaveBeenCalled();
    expect(startGatewayMock).not.toHaveBeenCalled();
    expect(leaseGuardianTokenMock).toHaveBeenCalledTimes(1);
    expect(readKeyFile()).toBe("ab".repeat(32));
  });

  test("repair cannot replace the persisted key while a service refuses to stop", async () => {
    removeIdentity();
    process.argv = [
      "bun",
      "cadet",
      "wake",
      "local-assistant",
      "--repair-guardian",
    ];
    stopProcessByPidFileMock.mockResolvedValue(false);
    isProcessAliveMock.mockReturnValue({ alive: true, pid: 123 });
    await expect(wake()).rejects.toThrow("could not be stopped");
    expect(existsSync(keyFilePath())).toBe(false);
    expect(startLocalDaemonMock).not.toHaveBeenCalled();
    expect(startGatewayMock).not.toHaveBeenCalled();
    expect(leaseGuardianTokenMock).not.toHaveBeenCalled();
  });

  for (const [portField, label] of [
    ["daemonPort", "assistant"],
    ["gatewayPort", "gateway"],
  ] as const) {
    test(`repair refuses an untracked ${label} listener before saving a key and can retry after it stops`, async () => {
      removeIdentity();
      localEntry.guardianBootstrapSecret = "existing-bootstrap";
      process.argv = [
        "bun",
        "cadet",
        "wake",
        "local-assistant",
        "--repair-guardian",
      ];
      const orphan = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response("not ready", { status: 503 }),
      });
      const port = orphan.port!;
      localEntry.resources![portField] = port;
      stopProcessByPidFileMock.mockImplementation(
        realProcessLib.stopProcessByPidFile,
      );
      findOpenPortMock.mockImplementation((candidate, options) =>
        candidate === port
          ? realPortAllocator.findOpenPort(candidate, options)
          : Promise.resolve(candidate),
      );
      generateLocalSigningKeyMock.mockReturnValue("ef".repeat(32));
      resolveProcessStateMock.mockResolvedValue({
        status: "needs_start",
        pid: null,
      });
      startLocalDaemonMock.mockImplementation(async () => {
        expect(readKeyFile()).toBe("ef".repeat(32));
        isProcessAliveMock.mockReturnValue({ alive: true, pid: 123 });
      });
      try {
        await expect(wake()).rejects.toThrow(
          `could not confirm that ${label} port ${port} is free`,
        );
        expect(existsSync(keyFilePath())).toBe(false);
        expect(startLocalDaemonMock).not.toHaveBeenCalled();
        expect(startGatewayMock).not.toHaveBeenCalled();
        expect(leaseGuardianTokenMock).not.toHaveBeenCalled();
        expect(findOpenPortMock).toHaveBeenCalledWith(port, {
          maxAttempts: 1,
          host: "127.0.0.1",
        });
        expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(
          503,
        );
        await orphan.stop(true);
        await wake();
        expect(readKeyFile()).toBe("ef".repeat(32));
        expect(startLocalDaemonMock).toHaveBeenCalledTimes(1);
        expect(startGatewayMock).toHaveBeenCalledTimes(1);
        expect(leaseGuardianTokenMock).toHaveBeenCalledTimes(1);
      } finally {
        await orphan.stop(true);
      }
    });
  }

  test("repair refuses to save a replacement key when a port cannot be checked", async () => {
    removeIdentity();
    process.argv = [
      "bun",
      "cadet",
      "wake",
      "local-assistant",
      "--repair-guardian",
    ];
    findOpenPortMock.mockRejectedValue(new Error("EPERM"));
    await expect(wake()).rejects.toThrow("no replacement key was saved");
    expect(existsSync(keyFilePath())).toBe(false);
    expect(startLocalDaemonMock).not.toHaveBeenCalled();
    expect(startGatewayMock).not.toHaveBeenCalled();
    expect(leaseGuardianTokenMock).not.toHaveBeenCalled();
  });

  test("repair persistence failure prevents launching with an ephemeral replacement key", async () => {
    removeIdentity();
    process.argv = [
      "bun",
      "cadet",
      "wake",
      "local-assistant",
      "--repair-guardian",
    ];
    persistRootSigningKeyMock.mockImplementation(() => {
      throw new Error("key file write failed");
    });
    await expect(wake()).rejects.toThrow("key file write failed");
    expect(startLocalDaemonMock).not.toHaveBeenCalled();
    expect(startGatewayMock).not.toHaveBeenCalled();
    expect(leaseGuardianTokenMock).not.toHaveBeenCalled();
  });

  test("restarts a running gateway without watch mode when backfilling the bootstrap secret", async () => {
    await wake();

    expect(saveLockfileAssistantMock).toHaveBeenCalledWith(
      expect.objectContaining({
        guardianBootstrapSecret: "generated-bootstrap-secret",
      }),
    );
    expect(stopProcessByPidFileMock).toHaveBeenCalledWith(
      join(tempDir, "gateway.pid"),
      "gateway",
    );
    expect(startGatewayMock).toHaveBeenCalledWith(
      false,
      expect.objectContaining({ instanceDir: tempDir }),
      {
        signingKey: "ab".repeat(32),
        bootstrapSecret: "generated-bootstrap-secret",
      },
    );
  });

  test("re-provisions the guardian token when missing and --repair-guardian is passed", async () => {
    process.argv = [
      "bun",
      "cadet",
      "wake",
      "--repair-guardian",
      "local-assistant",
    ];
    loadGuardianTokenMock.mockReturnValue(null);

    await wake();

    // Resets the gateway's spent bootstrap state, then re-leases against the
    // loopback gateway with the lockfile's bootstrap secret.
    expect(resetGuardianBootstrapMock).toHaveBeenCalledWith(
      "http://127.0.0.1:7830",
      "generated-bootstrap-secret",
    );
    expect(leaseGuardianTokenMock).toHaveBeenCalledWith(
      "http://127.0.0.1:7830",
      "local-assistant",
      "generated-bootstrap-secret",
    );
  });

  test("does NOT re-provision without --repair-guardian, even when the token is missing", async () => {
    // The automatic connect-repair path spawns `wake <id>` with no flags. A
    // re-lease here would revoke other device-bound tokens (other tabs / local
    // clients), so it must never run from auto-repair.
    process.argv = ["bun", "cadet", "wake", "local-assistant"];
    loadGuardianTokenMock.mockReturnValue(null);

    await wake();

    expect(resetGuardianBootstrapMock).not.toHaveBeenCalled();
    expect(leaseGuardianTokenMock).not.toHaveBeenCalled();
  });

  test("re-provisions even when a guardian token already exists", async () => {
    // A connect can 401 off a token whose local state looks healthy
    // (revoked, mis-seeded, wrong principal). The user explicitly confirmed
    // the destructive repair, so the flag forces a re-lease instead of
    // guessing from local token state and recreating the no-op loop.
    process.argv = [
      "bun",
      "cadet",
      "wake",
      "--repair-guardian",
      "local-assistant",
    ];
    // loadGuardianToken returns a healthy-looking token by default.
    await wake();

    expect(resetGuardianBootstrapMock).toHaveBeenCalledWith(
      "http://127.0.0.1:7830",
      "generated-bootstrap-secret",
    );
    expect(leaseGuardianTokenMock).toHaveBeenCalledWith(
      "http://127.0.0.1:7830",
      "local-assistant",
      "generated-bootstrap-secret",
    );
  });

  test("relaunches CES sibling when daemon is healthy but CES is dead", async () => {
    // Daemon is healthy (default mock) but CES pid says dead.
    // isProcessAliveMock defaults to { alive: false }.
    await wake();

    // startCes should be called to relaunch the dead sibling.
    expect(startCesMock).toHaveBeenCalledTimes(1);
    // startLocalDaemon should NOT be called (daemon already running).
    expect(startLocalDaemonMock).not.toHaveBeenCalled();
  });

  test("does NOT relaunch CES sibling when both daemon and CES are healthy", async () => {
    // Daemon is healthy (default mock). CES is also alive.
    isProcessAliveMock.mockReturnValue({ alive: true, pid: 789 });

    await wake();

    // startCes should NOT be called (CES is alive).
    expect(startCesMock).not.toHaveBeenCalled();
    // startLocalDaemon should NOT be called (daemon already running).
    expect(startLocalDaemonMock).not.toHaveBeenCalled();
  });

  test("does not duplicate an assistant already classified as stuck", async () => {
    localEntry.guardianBootstrapSecret = "existing-bootstrap-secret";
    resolveProcessStateMock.mockImplementation(
      async (_pidFile, _port, label) =>
        label === "Assistant"
          ? { status: "stuck", pid: 123 }
          : { status: "healthy", pid: 456 },
    );

    await wake();

    expect(startLocalDaemonMock).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("could not be stopped"),
    );
  });

  test("does not duplicate an assistant when a watch restart cannot stop it", async () => {
    localEntry.guardianBootstrapSecret = "existing-bootstrap-secret";
    isAssistantWatchModeAvailableMock.mockReturnValue(true);
    stopProcessByPidFileMock.mockResolvedValue(false);
    isProcessAliveMock.mockReturnValue({ alive: true, pid: 123 });

    await wake();

    expect(startLocalDaemonMock).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("could not be stopped for watch mode"),
    );
  });

  test("does not duplicate a gateway already classified as stuck", async () => {
    localEntry.guardianBootstrapSecret = "existing-bootstrap-secret";
    resolveProcessStateMock.mockImplementation(
      async (_pidFile, _port, label) =>
        label === "Gateway"
          ? { status: "stuck", pid: 456 }
          : { status: "healthy", pid: 123 },
    );

    await wake();

    expect(startGatewayMock).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Gateway running"),
    );
  });

  test("does not duplicate a gateway when a watch restart cannot stop it", async () => {
    localEntry.guardianBootstrapSecret = "existing-bootstrap-secret";
    isGatewayWatchModeAvailableMock.mockReturnValue(true);
    stopProcessByPidFileMock.mockResolvedValue(false);
    isProcessAliveMock.mockImplementation((pidFile) =>
      pidFile.endsWith("gateway.pid")
        ? { alive: true, pid: 456 }
        : { alive: false, pid: null },
    );

    await wake();

    expect(startGatewayMock).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Gateway running"),
    );
  });
});

describe("cadet wake: daemon startup failure", () => {
  const daemonPidOf = (dir: string) => join(dir, "daemon.pid");

  beforeEach(() => {
    process.argv = ["bun", "cadet", "wake", "local-assistant"];
    // The daemon needs starting; the gateway is already serving.
    resolveProcessStateMock.mockImplementation(
      async (_pidFile, _port, label) =>
        label === "Gateway"
          ? { status: "healthy", pid: 456 }
          : { status: "needs_start", pid: null },
    );
  });

  test("fails when the freshly spawned daemon is not running", async () => {
    /**
     * Tests that a daemon which aborts during startup (an occupied runtime
     * HTTP port) fails the command instead of reporting a successful wake.
     */

    // GIVEN the spawned daemon left no live process behind
    isProcessAliveMock.mockReturnValue({ alive: false, pid: null });

    // AND a foreign listener on the runtime HTTP port answers readiness in
    // the dead daemon's place
    probeDaemonReadinessWithRetryMock.mockResolvedValue("ready");
    const exitSpy = spyOn(process, "exit").mockImplementation(
      (code?: number | string | undefined): never => {
        throw new Error(`process.exit:${code}`);
      },
    );

    // WHEN wake runs
    const result = wake();

    // THEN it exits nonzero, names the port on stderr, and never claims
    // the wake completed
    await expect(result).rejects.toThrow("process.exit:1");
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("exited during startup"),
    );
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("7821"));
    expect(logSpy).not.toHaveBeenCalledWith("Wake complete.");
    expect(startGatewayMock).not.toHaveBeenCalled();
    exitSpy.mockRestore();
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
    probeDaemonReadinessWithRetryMock.mockResolvedValue("ready");

    // WHEN wake runs
    await wake();

    // THEN it reports success and starts the gateway
    expect(logSpy).toHaveBeenCalledWith("Wake complete.");
    expect(errorSpy).not.toHaveBeenCalled();
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

    // WHEN wake runs
    await wake();

    // THEN it reports the migration state and completes
    expect(logSpy).toHaveBeenCalledWith(
      "Assistant is still running database migrations; DB-backed routes return 503 until they finish.",
    );
    expect(logSpy).toHaveBeenCalledWith("Wake complete.");
  });
});

describe("cadet wake — app server restore", () => {
  const webhookConfig = { telegram: { botUsername: "bot" } };
  const enabledConfig = {
    ingress: { enabled: true, publicBaseUrl: "https://assistant.example.com" },
  };
  const workspaceDirOf = (dir: string) => join(dir, "workspace");
  let lockfileDir = "";

  beforeEach(() => {
    process.argv = ["bun", "cadet", "wake", "local-assistant"];
    // The restore gate reads the root lockfile; keep it off the real one.
    lockfileDir = mkdtempSync(join(tmpdir(), "cadet-wake-lockfile-"));
    process.env.CADET_LOCKFILE_DIR = lockfileDir;
  });

  afterEach(() => {
    rmSync(lockfileDir, { recursive: true, force: true });
    delete process.env.CADET_LOCKFILE_DIR;
  });

  // The restore flow stamps the `app` entry when it establishes the edge,
  // so seeding one is what the wake of an established assistant looks like.
  function stampRecordedAppServer(assistantId = "local-assistant"): void {
    assistantConfig.stampRootProcess("app", {
      pid: 4321,
      port: 7840,
      assistantId,
      startedAt: new Date().toISOString(),
    });
  }

  function stampRecordedTunnel(provider: "ngrok" | "tailscale"): void {
    assistantConfig.stampRootProcess("tunnel", {
      pid: 4321,
      provider,
      startedAt: new Date().toISOString(),
    });
  }

  test("a recorded app server wakes the edge back up and tunnels the edge port", async () => {
    loadRawConfigMock.mockReturnValue(webhookConfig);
    stampRecordedAppServer();
    stampRecordedTunnel("ngrok");

    await wake();

    expect(ensureAppServerMock).toHaveBeenCalledWith({
      assistantId: "local-assistant",
      workspaceDir: workspaceDirOf(tempDir),
      gatewayPort: 7830,
    });
    expect(ngrokStartMock).toHaveBeenCalledWith({
      port: 7840,
      workspaceDir: workspaceDirOf(tempDir),
      assistantId: "local-assistant",
    });
    expect(logSpy).toHaveBeenCalledWith("Wake complete.");
  });

  test("a recorded app server wakes the edge even without webhook integrations", async () => {
    loadRawConfigMock.mockReturnValue(enabledConfig);
    stampRecordedAppServer();
    stampRecordedTunnel("ngrok");

    await wake();

    expect(ensureAppServerMock).toHaveBeenCalledWith({
      assistantId: "local-assistant",
      workspaceDir: workspaceDirOf(tempDir),
      gatewayPort: 7830,
    });
    expect(ngrokStartMock).toHaveBeenCalledWith({
      port: 7840,
      workspaceDir: workspaceDirOf(tempDir),
      assistantId: "local-assistant",
    });
    expect(logSpy).toHaveBeenCalledWith("Wake complete.");
  });

  test("a docker wake restores the shared default-workspace edge", async () => {
    const defaultWorkspace = mkdtempSync(join(tmpdir(), "cadet-wake-default-"));
    const originalWorkspaceDir = process.env.CADET_WORKSPACE_DIR;
    process.env.CADET_WORKSPACE_DIR = defaultWorkspace;
    resolveTargetAssistantMock.mockReturnValue({
      assistantId: "docker-1",
      runtimeUrl: "http://localhost:7930",
      cloud: "docker",
    });
    loadRawConfigMock.mockReturnValue(enabledConfig);
    stampRecordedAppServer("docker-1");
    stampRecordedTunnel("ngrok");
    process.argv = ["bun", "cadet", "wake", "docker-1"];

    try {
      await wake();

      expect(ensureAppServerMock).toHaveBeenCalledWith({
        assistantId: "docker-1",
        workspaceDir: defaultWorkspace,
        gatewayPort: 7930,
      });
      // Container wakes run the same auto-tunnel as local wakes (docker
      // parity); the spawned agent records itself in the root lockfile.
      expect(ngrokStartMock).toHaveBeenCalledWith({
        port: 7840,
        workspaceDir: defaultWorkspace,
        assistantId: "docker-1",
      });
      expect(logSpy).toHaveBeenCalledWith("Wake complete.");
    } finally {
      if (originalWorkspaceDir === undefined) {
        delete process.env.CADET_WORKSPACE_DIR;
      } else {
        process.env.CADET_WORKSPACE_DIR = originalWorkspaceDir;
      }
      rmSync(defaultWorkspace, { recursive: true, force: true });
    }
  });

  test("a migrated docker assistant (containers never created) is recreated from the entry", async () => {
    const defaultWorkspace = mkdtempSync(join(tmpdir(), "cadet-wake-default-"));
    const originalWorkspaceDir = process.env.CADET_WORKSPACE_DIR;
    process.env.CADET_WORKSPACE_DIR = defaultWorkspace;
    const migratedEntry = {
      assistantId: "docker-1",
      runtimeUrl: "http://localhost:7930",
      cloud: "docker" as const,
      containerInfo: {
        assistantImage: "mycadet/mycadet-assistant:v0.12.7",
        gatewayImage: "mycadet/mycadet-gateway:v0.12.7",
        cesImage: "mycadet/mycadet-credential-executor:v0.12.7",
      },
    };
    resolveTargetAssistantMock.mockReturnValue(migratedEntry);
    loadRawConfigMock.mockReturnValue(enabledConfig);
    // The v0.0.10 run feedback: the containers were never created —
    // `docker start` answers "No such container".
    wakeContainersMock.mockImplementation(async () => {
      throw new Error(
        "Error response from daemon: No such container: docker-1-assistant",
      );
    });
    process.argv = ["bun", "cadet", "wake", "docker-1"];

    try {
      await wake();

      expect(recreateDockerContainersMock).toHaveBeenCalledWith(migratedEntry);
      expect(logSpy).toHaveBeenCalledWith("Docker containers started.");
      expect(logSpy).toHaveBeenCalledWith("Wake complete.");
    } finally {
      wakeContainersMock.mockImplementation(async () => {});
      if (originalWorkspaceDir === undefined) {
        delete process.env.CADET_WORKSPACE_DIR;
      } else {
        process.env.CADET_WORKSPACE_DIR = originalWorkspaceDir;
      }
      rmSync(defaultWorkspace, { recursive: true, force: true });
    }
  });

  test("a docker wake leaves an edge fronting another container alone", async () => {
    const defaultWorkspace = mkdtempSync(join(tmpdir(), "cadet-wake-default-"));
    const originalWorkspaceDir = process.env.CADET_WORKSPACE_DIR;
    process.env.CADET_WORKSPACE_DIR = defaultWorkspace;
    resolveTargetAssistantMock.mockReturnValue({
      assistantId: "docker-1",
      runtimeUrl: "http://localhost:7930",
      cloud: "docker",
    });
    loadRawConfigMock.mockReturnValue(enabledConfig);
    isIngressRunningMock.mockReturnValue(true);
    readIngressStateMock.mockReturnValue({
      listenPort: 7840,
      gatewayPort: 8030,
    });
    process.argv = ["bun", "cadet", "wake", "docker-1"];

    try {
      await wake();

      expect(ensureAppServerMock).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith("Wake complete.");
    } finally {
      if (originalWorkspaceDir === undefined) {
        delete process.env.CADET_WORKSPACE_DIR;
      } else {
        process.env.CADET_WORKSPACE_DIR = originalWorkspaceDir;
      }
      rmSync(defaultWorkspace, { recursive: true, force: true });
    }
  });

  test("a docker wake adopts an edge that already fronts it", async () => {
    const defaultWorkspace = mkdtempSync(join(tmpdir(), "cadet-wake-default-"));
    const originalWorkspaceDir = process.env.CADET_WORKSPACE_DIR;
    process.env.CADET_WORKSPACE_DIR = defaultWorkspace;
    resolveTargetAssistantMock.mockReturnValue({
      assistantId: "docker-1",
      runtimeUrl: "http://localhost:7930",
      cloud: "docker",
    });
    loadRawConfigMock.mockReturnValue(enabledConfig);
    stampRecordedAppServer("docker-1");
    isIngressRunningMock.mockReturnValue(true);
    readIngressStateMock.mockReturnValue({
      listenPort: 7840,
      gatewayPort: 7930,
    });
    // Ownership clears the restore, and `ensureAppServer` is what decides the
    // running edge still matches: it reports the reuse rather than a restart.
    ensureAppServerMock.mockResolvedValue({
      port: 7840,
      started: false,
    });
    process.argv = ["bun", "cadet", "wake", "docker-1"];

    try {
      await wake();

      expect(ensureAppServerMock).toHaveBeenCalledWith({
        assistantId: "docker-1",
        workspaceDir: defaultWorkspace,
        gatewayPort: 7930,
      });
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("already running on 127.0.0.1:7840"),
      );
    } finally {
      if (originalWorkspaceDir === undefined) {
        delete process.env.CADET_WORKSPACE_DIR;
      } else {
        process.env.CADET_WORKSPACE_DIR = originalWorkspaceDir;
      }
      rmSync(defaultWorkspace, { recursive: true, force: true });
    }
  });

  test("a failed docker edge restore falls back to the gateway tunnel", async () => {
    const defaultWorkspace = mkdtempSync(join(tmpdir(), "cadet-wake-default-"));
    const originalWorkspaceDir = process.env.CADET_WORKSPACE_DIR;
    process.env.CADET_WORKSPACE_DIR = defaultWorkspace;
    resolveTargetAssistantMock.mockReturnValue({
      assistantId: "docker-1",
      runtimeUrl: "http://localhost:7930",
      cloud: "docker",
    });
    loadRawConfigMock.mockReturnValue(enabledConfig);
    stampRecordedAppServer("docker-1");
    ensureAppServerMock.mockRejectedValue(new Error("nginx is not installed."));
    process.argv = ["bun", "cadet", "wake", "docker-1"];

    try {
      await wake();

      // Docker wakes get the same tunnel logic as local ones: when the edge
      // cannot be rebuilt, the auto-tunnel still fronts the gateway port so
      // webhook delivery survives.
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Webhooks still work"),
      );
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("webhook delivery are unavailable"),
      );
    } finally {
      if (originalWorkspaceDir === undefined) {
        delete process.env.CADET_WORKSPACE_DIR;
      } else {
        process.env.CADET_WORKSPACE_DIR = originalWorkspaceDir;
      }
      rmSync(defaultWorkspace, { recursive: true, force: true });
    }
  });

  test("a docker wake leaves a live edge fronting another assistant alone", async () => {
    const defaultWorkspace = mkdtempSync(join(tmpdir(), "cadet-wake-default-"));
    const originalWorkspaceDir = process.env.CADET_WORKSPACE_DIR;
    process.env.CADET_WORKSPACE_DIR = defaultWorkspace;
    resolveTargetAssistantMock.mockReturnValue({
      assistantId: "docker-1",
      runtimeUrl: "http://localhost:7930",
      cloud: "docker",
    });
    loadAllAssistantsMock.mockReturnValue([
      {
        assistantId: "docker-2",
        runtimeUrl: "http://localhost:8030",
        cloud: "docker",
      },
    ]);
    // The edge is up and stamped for docker-2 — a live process pid, so the
    // gate's liveness check passes and the ownership check fires.
    assistantConfig.stampRootProcess("app", {
      pid: process.pid,
      port: 7840,
      assistantId: "docker-2",
      startedAt: new Date().toISOString(),
    });
    process.argv = ["bun", "cadet", "wake", "docker-1"];

    try {
      await wake();

      expect(ensureAppServerMock).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith("Wake complete.");
    } finally {
      if (originalWorkspaceDir === undefined) {
        delete process.env.CADET_WORKSPACE_DIR;
      } else {
        process.env.CADET_WORKSPACE_DIR = originalWorkspaceDir;
      }
      rmSync(defaultWorkspace, { recursive: true, force: true });
    }
  });

  test("a docker wake waits for the gateway before restoring the edge", async () => {
    const defaultWorkspace = mkdtempSync(join(tmpdir(), "cadet-wake-default-"));
    const originalWorkspaceDir = process.env.CADET_WORKSPACE_DIR;
    process.env.CADET_WORKSPACE_DIR = defaultWorkspace;
    resolveTargetAssistantMock.mockReturnValue({
      assistantId: "docker-1",
      runtimeUrl: "http://localhost:7930",
      cloud: "docker",
    });
    loadRawConfigMock.mockReturnValue(enabledConfig);
    stampRecordedAppServer("docker-1");
    process.argv = ["bun", "cadet", "wake", "docker-1"];

    try {
      await wake();

      expect(waitForDaemonReadyMock).toHaveBeenCalledWith(7930, 5 * 60_000);
      expect(ensureAppServerMock).toHaveBeenCalled();
    } finally {
      if (originalWorkspaceDir === undefined) {
        delete process.env.CADET_WORKSPACE_DIR;
      } else {
        process.env.CADET_WORKSPACE_DIR = originalWorkspaceDir;
      }
      rmSync(defaultWorkspace, { recursive: true, force: true });
    }
  });

  test("a docker wake skips the edge when the gateway never comes up", async () => {
    const defaultWorkspace = mkdtempSync(join(tmpdir(), "cadet-wake-default-"));
    const originalWorkspaceDir = process.env.CADET_WORKSPACE_DIR;
    process.env.CADET_WORKSPACE_DIR = defaultWorkspace;
    resolveTargetAssistantMock.mockReturnValue({
      assistantId: "docker-1",
      runtimeUrl: "http://localhost:7930",
      cloud: "docker",
    });
    loadRawConfigMock.mockReturnValue(enabledConfig);
    stampRecordedAppServer("docker-1");
    waitForDaemonReadyMock.mockImplementation(async () => false);
    process.argv = ["bun", "cadet", "wake", "docker-1"];

    try {
      await wake();

      expect(ensureAppServerMock).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("did not come up"),
      );
      expect(logSpy).toHaveBeenCalledWith("Wake complete.");
    } finally {
      if (originalWorkspaceDir === undefined) {
        delete process.env.CADET_WORKSPACE_DIR;
      } else {
        process.env.CADET_WORKSPACE_DIR = originalWorkspaceDir;
      }
      rmSync(defaultWorkspace, { recursive: true, force: true });
    }
  });

  test("a docker wake with no recorded app server never waits for the gateway", async () => {
    const defaultWorkspace = mkdtempSync(join(tmpdir(), "cadet-wake-default-"));
    const originalWorkspaceDir = process.env.CADET_WORKSPACE_DIR;
    process.env.CADET_WORKSPACE_DIR = defaultWorkspace;
    resolveTargetAssistantMock.mockReturnValue({
      assistantId: "docker-1",
      runtimeUrl: "http://localhost:7930",
      cloud: "docker",
    });
    process.argv = ["bun", "cadet", "wake", "docker-1"];

    try {
      await wake();

      expect(waitForDaemonReadyMock).not.toHaveBeenCalled();
      expect(ensureAppServerMock).not.toHaveBeenCalled();
    } finally {
      if (originalWorkspaceDir === undefined) {
        delete process.env.CADET_WORKSPACE_DIR;
      } else {
        process.env.CADET_WORKSPACE_DIR = originalWorkspaceDir;
      }
      rmSync(defaultWorkspace, { recursive: true, force: true });
    }
  });

  test("a docker wake restores a saved ingress that no entry claims", async () => {
    const defaultWorkspace = mkdtempSync(join(tmpdir(), "cadet-wake-default-"));
    const originalWorkspaceDir = process.env.CADET_WORKSPACE_DIR;
    process.env.CADET_WORKSPACE_DIR = defaultWorkspace;
    // Tunneled before root-process tracking existed: publicBaseUrl is saved
    // with no record naming its owner. The sole container still owns it.
    resolveTargetAssistantMock.mockReturnValue({
      assistantId: "docker-1",
      runtimeUrl: "http://localhost:7930",
      cloud: "docker",
    });
    loadAllAssistantsMock.mockReturnValue([
      {
        assistantId: "docker-1",
        runtimeUrl: "http://localhost:7930",
        cloud: "docker",
      },
    ]);
    loadRawConfigMock.mockReturnValue(enabledConfig);
    stampRecordedAppServer("docker-1");
    isIngressRunningMock.mockReturnValue(false);
    process.argv = ["bun", "cadet", "wake", "docker-1"];

    try {
      await wake();

      expect(ensureAppServerMock).toHaveBeenCalledWith({
        assistantId: "docker-1",
        workspaceDir: defaultWorkspace,
        gatewayPort: 7930,
      });
    } finally {
      if (originalWorkspaceDir === undefined) {
        delete process.env.CADET_WORKSPACE_DIR;
      } else {
        process.env.CADET_WORKSPACE_DIR = originalWorkspaceDir;
      }
      rmSync(defaultWorkspace, { recursive: true, force: true });
    }
  });

  test("a docker wake respects an ingress claim from another environment", async () => {
    const defaultWorkspace = mkdtempSync(join(tmpdir(), "cadet-wake-default-"));
    const originalWorkspaceDir = process.env.CADET_WORKSPACE_DIR;
    process.env.CADET_WORKSPACE_DIR = defaultWorkspace;
    resolveTargetAssistantMock.mockReturnValue({
      assistantId: "docker-1",
      runtimeUrl: "http://localhost:7930",
      cloud: "docker",
    });
    loadAllAssistantsAcrossEnvsMock.mockReturnValue([
      {
        assistantId: "docker-2",
        runtimeUrl: "http://localhost:8030",
        cloud: "docker",
      },
    ]);
    loadRawConfigMock.mockReturnValue(enabledConfig);
    isIngressRunningMock.mockReturnValue(false);
    process.argv = ["bun", "cadet", "wake", "docker-1"];

    try {
      await wake();

      expect(ensureAppServerMock).not.toHaveBeenCalled();
    } finally {
      if (originalWorkspaceDir === undefined) {
        delete process.env.CADET_WORKSPACE_DIR;
      } else {
        process.env.CADET_WORKSPACE_DIR = originalWorkspaceDir;
      }
      rmSync(defaultWorkspace, { recursive: true, force: true });
    }
  });

  test("a docker wake with no recorded app server leaves the edge alone", async () => {
    const defaultWorkspace = mkdtempSync(join(tmpdir(), "cadet-wake-default-"));
    const originalWorkspaceDir = process.env.CADET_WORKSPACE_DIR;
    process.env.CADET_WORKSPACE_DIR = defaultWorkspace;
    resolveTargetAssistantMock.mockReturnValue({
      assistantId: "docker-1",
      runtimeUrl: "http://localhost:7930",
      cloud: "docker",
    });
    process.argv = ["bun", "cadet", "wake", "docker-1"];

    try {
      await wake();

      expect(ensureAppServerMock).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith("Wake complete.");
    } finally {
      if (originalWorkspaceDir === undefined) {
        delete process.env.CADET_WORKSPACE_DIR;
      } else {
        process.env.CADET_WORKSPACE_DIR = originalWorkspaceDir;
      }
      rmSync(defaultWorkspace, { recursive: true, force: true });
    }
  });

  test("a recorded tunnel fronts the gateway port when no edge is recorded", async () => {
    stampRecordedTunnel("ngrok");

    await wake();

    expect(ensureAppServerMock).not.toHaveBeenCalled();
    expect(ngrokStartMock).toHaveBeenCalledWith({
      port: 7830,
      workspaceDir: workspaceDirOf(tempDir),
      assistantId: "local-assistant",
    });
  });

  test("a wake with no recorded app server or tunnel skips the edge and the tunnel", async () => {
    loadRawConfigMock.mockReturnValue({ ingress: { enabled: true } });

    await wake();

    expect(ensureAppServerMock).not.toHaveBeenCalled();
    expect(ngrokStartMock).not.toHaveBeenCalled();
  });

  test("a running edge is rebuilt through ensureAppServer, never adopted at its recorded port", async () => {
    // Recorded mode and gateway port are not a licence to reuse: only
    // ensureAppServer compares the injected-config fingerprint, so an edge
    // predating the current edge template (one serving no assistantId, which
    // makes the identity probe degrade to always-healthy) must be rebuilt
    // rather than carried across the wake at its recorded listen port.
    loadRawConfigMock.mockReturnValue(webhookConfig);
    stampRecordedAppServer();
    stampRecordedTunnel("ngrok");
    isIngressRunningMock.mockReturnValue(true);
    readIngressStateMock.mockReturnValue({
      listenPort: 7845,
      gatewayPort: 7830,
      remoteWebConfigHash: "fingerprint-of-an-older-edge-template",
    });

    await wake();

    expect(ensureAppServerMock).toHaveBeenCalledWith({
      assistantId: "local-assistant",
      workspaceDir: workspaceDirOf(tempDir),
      gatewayPort: 7830,
    });
    expect(ngrokStartMock).toHaveBeenCalledWith({
      port: 7840,
      workspaceDir: workspaceDirOf(tempDir),
      assistantId: "local-assistant",
    });
  });

  test("a failed rebuild keeps tunneling the SPA edge that is still running", async () => {
    // web-dist-missing bails before the running edge is stopped, and a drifted
    // edge whose stop fails reports staleRemoteWebConfig; both throw while the
    // edge keeps serving. Tunneling the gateway directly would put the
    // sensitive-route denylist behind the tunnel instead of in front of it.
    loadRawConfigMock.mockReturnValue(webhookConfig);
    stampRecordedAppServer();
    stampRecordedTunnel("ngrok");
    isIngressRunningMock.mockReturnValue(true);
    readIngressStateMock.mockReturnValue({
      listenPort: 7845,
      gatewayPort: 7830,
      remoteWebConfigHash: "fingerprint-of-an-older-edge-template",
    });
    ensureAppServerMock.mockRejectedValue(
      new Error(
        "The nginx edge is still serving an outdated remote web config and could not be restarted with the updated one. Cadet could not stop the nginx process (PID 4242), even with SIGKILL. Stop it by hand and retry, or run `cadet sleep` to shut the assistant down entirely.",
      ),
    );

    await wake();

    expect(ngrokStartMock).toHaveBeenCalledWith({
      port: 7845,
      workspaceDir: workspaceDirOf(tempDir),
      assistantId: "local-assistant",
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("127.0.0.1:7845"),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Stop it by hand and retry"),
    );
  });

  test("a failed rebuild falls back to the gateway port when the running edge fronts another gateway", async () => {
    loadRawConfigMock.mockReturnValue(webhookConfig);
    stampRecordedAppServer();
    stampRecordedTunnel("ngrok");
    isIngressRunningMock.mockReturnValue(true);
    readIngressStateMock.mockReturnValue({
      listenPort: 7845,
      gatewayPort: 7831,
    });
    ensureAppServerMock.mockRejectedValue(
      new Error("The nginx edge is still proxying gateway port 7831."),
    );

    await wake();

    expect(ngrokStartMock).toHaveBeenCalledWith({
      port: 7830,
      workspaceDir: workspaceDirOf(tempDir),
      assistantId: "local-assistant",
    });
  });

  test("nginx-missing falls back to the gateway-port tunnel with a warning", async () => {
    loadRawConfigMock.mockReturnValue(webhookConfig);
    stampRecordedAppServer();
    stampRecordedTunnel("ngrok");
    ensureAppServerMock.mockRejectedValue(
      new Error(
        "nginx is not installed, so the app server cannot start. See https://nginx.org/en/docs/install.html for how to install, or point NGINX_BIN at an existing binary.",
      ),
    );

    await wake();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("https://nginx.org/en/docs/install.html"),
    );
    // No tunnel is recorded here, so no provider can be named and the advice
    // points at the help that lists them.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "Run `cadet tunnel --help` to rebuild the app server.",
      ),
    );
    expect(ngrokStartMock).toHaveBeenCalledWith({
      port: 7830,
      workspaceDir: workspaceDirOf(tempDir),
      assistantId: "local-assistant",
    });
    expect(logSpy).toHaveBeenCalledWith("Wake complete.");
  });

  test("a failed rebuild names the provider that last tunneled here", async () => {
    loadRawConfigMock.mockReturnValue({
      ...webhookConfig,
      ingress: {
        lastTunnel: {
          provider: "cloudflare",
          publicBaseUrl: "https://assistant.example.com",
        },
      },
    });
    stampRecordedAppServer();
    ensureAppServerMock.mockRejectedValue(new Error("edge rebuild failed"));

    await wake();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "Run `cadet tunnel start --provider cloudflare` to rebuild the app server.",
      ),
    );
  });

  test("a failed rebuild prefers the pairing tunnel over the public one beside it", async () => {
    // A tailnet pairing tunnel leaves the older public record in place, so the
    // advice has to name the tunnel actually in front of this assistant.
    loadRawConfigMock.mockReturnValue({
      ...webhookConfig,
      ingress: {
        lastTunnel: {
          provider: "cloudflare",
          publicBaseUrl: "https://assistant.example.com",
        },
        pairingTunnel: {
          provider: "tailscale",
          publicBaseUrl: "https://assistant.example.ts.net",
        },
      },
    });
    stampRecordedAppServer();
    ensureAppServerMock.mockRejectedValue(new Error("edge rebuild failed"));

    await wake();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "Run `cadet tunnel start --provider tailscale` to rebuild the app server.",
      ),
    );
  });

  test("a reused edge still points the tunnel at its listen port", async () => {
    loadRawConfigMock.mockReturnValue(enabledConfig);
    stampRecordedAppServer();
    stampRecordedTunnel("ngrok");
    ensureAppServerMock.mockResolvedValue({
      port: 7841,
      started: false,
    });

    await wake();

    expect(ngrokStartMock).toHaveBeenCalledWith({
      port: 7841,
      workspaceDir: workspaceDirOf(tempDir),
      assistantId: "local-assistant",
    });
  });

  describe("--all", () => {
    function makeAllEntry(
      assistantId: string,
      instanceDir: string,
    ): LockfileAssistant {
      return {
        assistantId,
        runtimeUrl: "http://127.0.0.1:7830",
        cloud: "local",
        resources: {
          instanceDir,
          daemonPort: 7821,
          gatewayPort: 7830,
          cesPort: 7822,
        },
      };
    }

    function makeAllEntries(): LockfileAssistant[] {
      mkdirSync(join(tempDir, "instance-1"), { recursive: true });
      mkdirSync(join(tempDir, "instance-2"), { recursive: true });
      return [
        makeAllEntry("wake-all-1", join(tempDir, "instance-1")),
        makeAllEntry("wake-all-2", join(tempDir, "instance-2")),
      ];
    }

    // Cold-start both assistants so each wake's starts are observable.
    function mockColdStart(): void {
      resolveProcessStateMock.mockImplementation(async () => ({
        status: "needs_start",
        pid: null,
      }));
      isProcessAliveMock.mockReturnValue({ alive: true, pid: 123 });
    }

    test("starts every assistant in the lockfile", async () => {
      mockColdStart();
      loadAllAssistantsMock.mockReturnValue(makeAllEntries());
      process.argv = ["bun", "cadet", "wake", "--all"];

      await wake();

      expect(startCesMock).toHaveBeenCalledTimes(2);
      expect(startLocalDaemonMock).toHaveBeenCalledTimes(2);
      expect(startGatewayMock).toHaveBeenCalledTimes(2);
    });

    test("continues past a failing assistant and exits 1", async () => {
      mockColdStart();
      loadAllAssistantsMock.mockReturnValue([
        // Missing resources is a deliberate refusal for this entry.
        {
          assistantId: "wake-all-1",
          runtimeUrl: "http://127.0.0.1:7830",
          cloud: "local",
        },
        makeAllEntry("wake-all-2", join(tempDir, "instance-2")),
      ]);
      mkdirSync(join(tempDir, "instance-2"), { recursive: true });
      process.argv = ["bun", "cadet", "wake", "--all"];

      const exitSpy = spyOn(process, "exit").mockImplementation(
        (code?: number | string | undefined): never => {
          throw new Error(`process.exit:${code}`);
        },
      );

      try {
        await expect(wake()).rejects.toThrow("process.exit:1");
        expect(errorSpy.mock.calls.flat().join("\n")).toContain(
          "failed to wake 'wake-all-1'",
        );
      } finally {
        exitSpy.mockRestore();
      }

      // The healthy assistant was still started.
      expect(startCesMock).toHaveBeenCalledTimes(1);
      expect(startLocalDaemonMock).toHaveBeenCalledTimes(1);
      expect(startGatewayMock).toHaveBeenCalledTimes(1);
    });

    test("exits 1 when there is nothing to start", async () => {
      loadAllAssistantsMock.mockReturnValue([]);
      process.argv = ["bun", "cadet", "wake", "--all"];

      const exitSpy = spyOn(process, "exit").mockImplementation(
        (code?: number | string | undefined): never => {
          throw new Error(`process.exit:${code}`);
        },
      );

      try {
        await expect(wake()).rejects.toThrow("process.exit:1");
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining("no assistants found"),
        );
      } finally {
        exitSpy.mockRestore();
      }
    });

    test("refuses --all combined with a name", async () => {
      process.argv = ["bun", "cadet", "wake", "local-assistant", "--all"];

      const exitSpy = spyOn(process, "exit").mockImplementation(
        (code?: number | string | undefined): never => {
          throw new Error(`process.exit:${code}`);
        },
      );

      try {
        await expect(wake()).rejects.toThrow("process.exit:1");
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining("--all cannot be combined"),
        );
      } finally {
        exitSpy.mockRestore();
      }
    });

    test("refuses --all with --foreground and --repair-guardian", async () => {
      const exitSpy = spyOn(process, "exit").mockImplementation(
        (code?: number | string | undefined): never => {
          throw new Error(`process.exit:${code}`);
        },
      );

      try {
        for (const flag of ["--foreground", "--repair-guardian"]) {
          process.argv = ["bun", "cadet", "wake", "--all", flag];
          await expect(wake()).rejects.toThrow("process.exit:1");
        }
      } finally {
        exitSpy.mockRestore();
      }

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "--all cannot be combined with --foreground or --repair-guardian",
        ),
      );
    });
  });
});
