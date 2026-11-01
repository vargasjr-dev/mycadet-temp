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

import * as assistantConfig from "../lib/assistant-config.js";
import * as localModeModule from "@mycadet/local-mode";
import * as docker from "../lib/remotes/docker.js";
import * as guardianToken from "../lib/guardian-token.js";
import * as httpClient from "../lib/http-client.js";
import * as local from "../lib/remotes/local.js";
import * as nginxIngress from "../lib/servers/nginx.js";
import * as ngrok from "../lib/tunnels/ngrok.js";
import * as processLib from "../lib/process.js";
import * as portAllocator from "../lib/port-allocator.js";
import * as rootSigningKey from "../lib/root-signing-key.js";
import type { LocalAssistant } from "@mycadet/local-mode/contract";
import type { LockfileAssistant } from "@mycadet/local-mode/contract";
import { makeGuardianTokenData } from "./helpers/guardian-token.js";

const realAssistantConfig = { ...assistantConfig };
const realLocalMode = { ...localModeModule };
const realDocker = { ...docker };
const realGuardianToken = { ...guardianToken };
const realLocal = { ...local };
const realNgrok = { ...ngrok };
const realProcessLib = { ...processLib };
const realPortAllocator = { ...portAllocator };
const realRootSigningKey = { ...rootSigningKey };

const resolveTargetAssistantMock =
  mock<typeof assistantConfig.resolveTargetAssistant>();
const loadAllAssistantsMock = mock<typeof localModeModule.loadAllAssistants>(
  () => [],
);
const saveLockfileAssistantMock = mock<
  typeof localModeModule.saveLockfileAssistant
>(() => ({ ok: true, lockfile: { assistants: [], activeAssistant: null } }));
const getDaemonPidPathMock = mock<typeof local.getDaemonPidPath>((entry) =>
  join(
    entry && entry.cloud === "local" && entry.instanceDir
      ? entry.instanceDir
      : "missing",
    "daemon.pid",
  ),
);

mock.module("../lib/assistant-config.js", () => ({
  ...realAssistantConfig,
  resolveTargetAssistant: resolveTargetAssistantMock,
}));

const dockerResourceNamesMock = mock<
  typeof localModeModule.dockerResourceNames
>(localModeModule.dockerResourceNames);
const wakeContainersMock = mock<typeof docker.wakeContainers>(async () => {});
const recreateDockerContainersMock = mock<
  typeof docker.recreateDockerContainers
>(async () => {});

mock.module("@mycadet/local-mode", () => ({
  ...localModeModule,
  dockerResourceNames: dockerResourceNamesMock,
}));
mock.module("../lib/remotes/docker.js", () => ({
  ...realDocker,
  wakeContainers: wakeContainersMock,
  recreateDockerContainers: recreateDockerContainersMock,
}));

// Default: a token exists, so the re-provision recovery path is skipped. Tests
// that exercise recovery override loadGuardianToken to return null.
const loadGuardianTokenMock = mock<typeof guardianToken.loadGuardianToken>(() =>
  makeGuardianTokenData({ accessToken: "existing" }),
);
const leaseGuardianTokenMock = mock<typeof guardianToken.leaseGuardianToken>(
  async () => makeGuardianTokenData(),
);

mock.module("../lib/guardian-token.js", () => ({
  ...realGuardianToken,
  loadGuardianToken: loadGuardianTokenMock,
  leaseGuardianToken: leaseGuardianTokenMock,
}));

const resolveProcessStateMock = mock<typeof processLib.resolveProcessState>(
  async (_pidFile, _port, label) => ({
    status: "healthy",
    pid: label === "Gateway" ? 456 : 123,
  }),
);
const stopProcessByPidFileMock = mock<
  typeof localModeModule.stopProcessByPidFile
>(async () => true);
const isProcessAliveMock = mock<typeof localModeModule.isProcessAlive>(() => ({
  alive: false,
  pid: null,
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

mock.module("../lib/remotes/local", () => ({
  ...realLocal,
  isAssistantWatchModeAvailable: isAssistantWatchModeAvailableMock,
  isGatewayWatchModeAvailable: isGatewayWatchModeAvailableMock,
  startLocalDaemon: startLocalDaemonMock,
  startGateway: startGatewayMock,
  startCes: startCesMock,
  getDaemonPidPath: getDaemonPidPathMock,
}));

const ngrokRunMock = mock<typeof ngrok.runNgrokTunnel>(async () => ({
  publicUrl: "https://tunnel.example.com",
  waitForExit: Promise.resolve(),
}));

mock.module("../lib/tunnels/ngrok", () => ({
  ...realNgrok,
  NGROK_PROVIDER: {
    ...realNgrok.NGROK_PROVIDER,
    run: ngrokRunMock,
  },
}));

const realNginxIngress = { ...nginxIngress };

const ensureAppServerMock = mock<typeof nginxIngress.ensureAppServer>(
  async () => ({ port: 7840, started: true, shellMode: "web" }),
);
const isIngressRunningMock = mock<typeof localModeModule.isIngressRunning>(
  () => false,
);
const readIngressStateMock = mock<typeof localModeModule.readIngressState>(
  () => null,
);

mock.module("../lib/servers/nginx.js", () => ({
  ...realNginxIngress,
  ensureAppServer: ensureAppServerMock,
}));

// resolveProcessState still lives in cli/src/lib/process.ts (the file owns
// it) — mock it there. The process-STOP cluster and the ingress reads moved
// to the package (process.ts and servers/nginx.ts no longer re-export them) —
// mock those where the wake path imports them now.
mock.module("../lib/process", () => ({
  ...realProcessLib,
  resolveProcessState: resolveProcessStateMock,
}));
mock.module("@mycadet/local-mode", () => ({
  ...realLocalMode,
  saveLockfileAssistant: saveLockfileAssistantMock,
  loadAllAssistants: loadAllAssistantsMock,
  dockerResourceNames: dockerResourceNamesMock,
  stopProcessByPidFile: stopProcessByPidFileMock,
  isProcessAlive: isProcessAliveMock,
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
let localEntry: LocalAssistant;

function makeLocalEntry(): LocalAssistant {
  tempDir = mkdtempSync(join(tmpdir(), "cadet-wake-test-"));
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
  saveLockfileAssistantMock.mockReset();
  saveLockfileAssistantMock.mockImplementation(() => ({
    ok: true,
    lockfile: { assistants: [], activeAssistant: null },
  }));
  getDaemonPidPathMock.mockReset();
  getDaemonPidPathMock.mockImplementation((entry) =>
    join(
      entry && entry.cloud === "local" && entry.instanceDir
        ? entry.instanceDir
        : "missing",
      "daemon.pid",
    ),
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
  loadGuardianTokenMock.mockReset();
  loadGuardianTokenMock.mockReturnValue(
    makeGuardianTokenData({ accessToken: "existing" }),
  );
  leaseGuardianTokenMock.mockReset();
  leaseGuardianTokenMock.mockResolvedValue(makeGuardianTokenData());
  ngrokRunMock.mockReset();
  ngrokRunMock.mockImplementation(async () => ({
    publicUrl: "https://tunnel.example.com",
    waitForExit: Promise.resolve(),
  }));
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
  mock.module("@mycadet/local-mode", () => realLocalMode);
  mock.module("../lib/assistant-config.js", () => realAssistantConfig);
  mock.module("../lib/remotes/docker.js", () => realDocker);
  mock.module("../lib/guardian-token.js", () => realGuardianToken);
  mock.module("../lib/process", () => realProcessLib);
  mock.module("../lib/port-allocator.js", () => realPortAllocator);
  mock.module("../lib/remotes/local", () => realLocal);
  mock.module("../lib/tunnels/ngrok", () => realNgrok);
  mock.module("../lib/servers/nginx.js", () => realNginxIngress);
  mock.module("../lib/http-client.js", () => realHttpClient);
  mock.module("../lib/root-signing-key.js", () => realRootSigningKey);
});

describe("cadet wake", () => {
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
  let lockfileDir = "";

  beforeEach(() => {
    process.argv = ["bun", "cadet", "wake", "local-assistant"];
    // The restore gate reads the root lockfile; keep it off the real one.
    lockfileDir = mkdtempSync(join(tmpdir(), "cadet-wake-lockfile-"));
    process.env.XDG_CONFIG_HOME = lockfileDir;
  });

  afterEach(() => {
    rmSync(lockfileDir, { recursive: true, force: true });
    delete process.env.XDG_CONFIG_HOME;
  });

  // The restore flow stamps the `app` entry when it establishes the edge,
  // so seeding one is what the wake of an established assistant looks like.
  function stampRecordedAppServer(port = 7840, pid = 4321): void {
    assistantConfig.stampRootProcess("app", {
      pid,
      port,
      startedAt: new Date().toISOString(),
    });
  }

  function stampRecordedTunnel(
    provider: "ngrok" | "tailscale" | "cloudflare",
    publicUrl: string | null = `https://${provider}.example.test`,
  ): void {
    assistantConfig.stampRootProcess("tunnel", {
      pid: 4321,
      provider,
      startedAt: new Date().toISOString(),
      ...(publicUrl ? { publicUrl } : {}),
    });
  }

  test("a recorded app server wakes the edge back up and tunnels the edge port", async () => {
    stampRecordedAppServer();
    stampRecordedTunnel("ngrok");

    await wake();

    expect(ensureAppServerMock).toHaveBeenCalledWith();
    expect(ngrokRunMock).toHaveBeenCalledWith({ port: 7840 });
    expect(logSpy).toHaveBeenCalledWith("Wake complete.");
  });

  test("a docker wake restores the shared default-workspace edge", async () => {
    const defaultWorkspace = mkdtempSync(join(tmpdir(), "cadet-wake-default-"));
    const originalWorkspaceDir = process.env.CADET_WORKSPACE_DIR;
    process.env.CADET_WORKSPACE_DIR = defaultWorkspace;
    resolveTargetAssistantMock.mockReturnValue({
      assistantId: "docker-1",
      cloud: "docker",
      port: 7930,
      daemonPort: 7821,
    });
    stampRecordedAppServer();
    stampRecordedTunnel("ngrok");
    process.argv = ["bun", "cadet", "wake", "docker-1"];

    try {
      await wake();

      expect(ensureAppServerMock).toHaveBeenCalledWith();
      // Container wakes run the same auto-tunnel as local wakes (docker
      // parity); the spawned agent records itself in the root lockfile.
      expect(ngrokRunMock).toHaveBeenCalledWith({ port: 7840 });
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
      cloud: "docker" as const,
      port: 7830,
      containerInfo: {
        assistantImage: "mycadet/mycadet-assistant:v0.12.7",
        gatewayImage: "mycadet/mycadet-gateway:v0.12.7",
        cesImage: "mycadet/mycadet-credential-executor:v0.12.7",
      },
    };
    resolveTargetAssistantMock.mockReturnValue(migratedEntry);
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
      cloud: "docker",
      port: 7930,
      daemonPort: 7821,
    });
    isIngressRunningMock.mockReturnValue(true);
    readIngressStateMock.mockReturnValue({
      listenPort: 7840,
      gatewayUrl: "http://127.0.0.1:8030",
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
      cloud: "docker",
      port: 7930,
      daemonPort: 7821,
    });
    stampRecordedAppServer();
    isIngressRunningMock.mockReturnValue(true);
    readIngressStateMock.mockReturnValue({
      listenPort: 7840,
      gatewayUrl: "http://127.0.0.1:7930",
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

      expect(ensureAppServerMock).toHaveBeenCalledWith();
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
      cloud: "docker",
      port: 7930,
      daemonPort: 7821,
    });
    stampRecordedAppServer();
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

  test("a docker wake waits for the gateway before restoring the edge", async () => {
    const defaultWorkspace = mkdtempSync(join(tmpdir(), "cadet-wake-default-"));
    const originalWorkspaceDir = process.env.CADET_WORKSPACE_DIR;
    process.env.CADET_WORKSPACE_DIR = defaultWorkspace;
    resolveTargetAssistantMock.mockReturnValue({
      assistantId: "docker-1",
      cloud: "docker",
      port: 7930,
      daemonPort: 7821,
    });
    stampRecordedAppServer();
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
      cloud: "docker",
      port: 7930,
      daemonPort: 7821,
    });
    stampRecordedAppServer();
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
      cloud: "docker",
      port: 7930,
      daemonPort: 7821,
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
      cloud: "docker",
      port: 7930,
      daemonPort: 7821,
    });
    loadAllAssistantsMock.mockReturnValue([
      {
        assistantId: "docker-1",
        cloud: "docker",
        port: 7830,
      },
    ]);
    stampRecordedAppServer();
    isIngressRunningMock.mockReturnValue(false);
    process.argv = ["bun", "cadet", "wake", "docker-1"];

    try {
      await wake();

      expect(ensureAppServerMock).toHaveBeenCalledWith();
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
      cloud: "docker",
      port: 7930,
      daemonPort: 7821,
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

  test("a recorded tunnel without a recorded app server re-establishes nothing", async () => {
    // The tunnel fronts the app server, never the gateway directly — no
    // recorded edge leaves the wake nothing to restore and nothing for the
    // tunnel to front.
    stampRecordedTunnel("ngrok");

    await wake();

    expect(ensureAppServerMock).not.toHaveBeenCalled();
    expect(ngrokRunMock).not.toHaveBeenCalled();
  });

  test("a wake with no recorded app server or tunnel skips the edge and the tunnel", async () => {
    await wake();

    expect(ensureAppServerMock).not.toHaveBeenCalled();
    expect(ngrokRunMock).not.toHaveBeenCalled();
  });

  test("a running edge is rebuilt through ensureAppServer, never adopted at its recorded port", async () => {
    // Recorded mode and gateway port are not a licence to reuse: only
    // ensureAppServer compares the injected-config fingerprint, so an edge
    // predating the current edge template (one serving no assistantId, which
    // makes the identity probe degrade to always-healthy) must be rebuilt
    // rather than carried across the wake at its recorded listen port.
    stampRecordedAppServer();
    stampRecordedTunnel("ngrok");
    isIngressRunningMock.mockReturnValue(true);
    readIngressStateMock.mockReturnValue({
      listenPort: 7845,
      gatewayUrl: "http://127.0.0.1:7830",
      remoteWebConfigHash: "fingerprint-of-an-older-edge-template",
    });

    await wake();

    expect(ensureAppServerMock).toHaveBeenCalledWith();
    expect(ngrokRunMock).toHaveBeenCalledWith({ port: 7840 });
  });

  test("a failed rebuild keeps tunneling the SPA edge that is still running", async () => {
    // web-dist-missing bails before the running edge is stopped, and a drifted
    // edge whose stop fails reports staleRemoteWebConfig; both throw while the
    // edge keeps serving. Tunneling the gateway directly would put the
    // sensitive-route denylist behind the tunnel instead of in front of it.
    // The lockfile's app record is the survivor's port source: stamp 7845
    // against a live pid.
    stampRecordedAppServer(7845, process.pid);
    stampRecordedTunnel("ngrok");
    isIngressRunningMock.mockReturnValue(true);
    readIngressStateMock.mockReturnValue({
      listenPort: 7845,
      gatewayUrl: "http://127.0.0.1:7830",
      remoteWebConfigHash: "fingerprint-of-an-older-edge-template",
    });
    ensureAppServerMock.mockRejectedValue(
      new Error(
        "The nginx edge is still serving an outdated remote web config and could not be restarted with the updated one. Cadet could not stop the nginx process (PID 4242), even with SIGKILL. Stop it by hand and retry, or run `cadet sleep` to shut the assistant down entirely.",
      ),
    );

    await wake();

    expect(ngrokRunMock).toHaveBeenCalledWith({ port: 7845 });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("127.0.0.1:7845"),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Stop it by hand and retry"),
    );
  });

  test("the lockfile's app record drives the surviving port — not the assistant", async () => {
    stampRecordedAppServer(7840, process.pid);
    stampRecordedTunnel("ngrok");
    isIngressRunningMock.mockReturnValue(true);
    readIngressStateMock.mockReturnValue({
      listenPort: 7845,
      gatewayUrl: "http://127.0.0.1:7831",
    });
    ensureAppServerMock.mockRejectedValue(
      new Error("The nginx edge is still proxying gateway port 7831."),
    );

    await wake();

    expect(ngrokRunMock).toHaveBeenCalledWith({ port: 7840 });
  });

  test("nginx-missing warns and skips the tunnel — there is no gateway-port fallback", async () => {
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
    // The workspace config records no tunnel, but the lockfile's tunnel
    // record does — the advice names the record's provider.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "Run `cadet tunnel start --provider ngrok` to rebuild the app server.",
      ),
    );
    // The tunnel fronts the app server; with the edge unrestorable there is
    // no gateway-port fallback to front instead.
    expect(ngrokRunMock).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith("Wake complete.");
  });

  test("a failed rebuild names the provider that last tunneled here", async () => {
    stampRecordedAppServer();
    stampRecordedTunnel("cloudflare");
    ensureAppServerMock.mockRejectedValue(new Error("edge rebuild failed"));

    await wake();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "Run `cadet tunnel start --provider cloudflare` to rebuild the app server.",
      ),
    );
  });

  test("a failed rebuild names the record's tunnel, not the workspace's stale one", async () => {
    // The advice names the tunnel actually in front of this assistant: the
    // root lockfile's record, which is the only record there is.
    stampRecordedAppServer();
    // A pairing-only run published no ingress base URL — the record shape
    // that says the tunnel in front is the tailnet serve.
    stampRecordedTunnel("tailscale", null);
    ensureAppServerMock.mockRejectedValue(new Error("edge rebuild failed"));

    await wake();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "Run `cadet tunnel start --provider tailscale` to rebuild the app server.",
      ),
    );
  });

  test("a reused edge still points the tunnel at its listen port", async () => {
    stampRecordedAppServer();
    stampRecordedTunnel("ngrok");
    ensureAppServerMock.mockResolvedValue({
      port: 7841,
      started: false,
    });

    await wake();

    expect(ngrokRunMock).toHaveBeenCalledWith({ port: 7841 });
  });

  describe("--all", () => {
    function makeAllEntry(
      assistantId: string,
      instanceDir: string,
    ): LockfileAssistant {
      // The identity lives in the instance's key file (the resolve is
      // key-file-only), so every --all fixture seeds one or the wake fails
      // its continuity check and wakeAll's failure exit kills the runner.
      mkdirSync(join(instanceDir, "gateway-security"), { recursive: true });
      writeFileSync(
        join(instanceDir, "gateway-security", "actor-token-signing-key"),
        Buffer.from("ab".repeat(32), "hex"),
      );
      return {
        assistantId,
        cloud: "local",
        instanceDir,
        daemonPort: 7821,
        port: 7830,
        cesPort: 7822,
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
      // A real wake failure for the first entry: the CES sibling's spawn
      // dies. (The entry's own shape can't be the failure anymore — a
      // missing instanceDir falls back to the shared data root — so the
      // failure comes from a start the wake actually performs.)
      startCesMock.mockRejectedValueOnce(new Error("ces spawn failed"));
      loadAllAssistantsMock.mockReturnValue([
        makeAllEntry("wake-all-1", join(tempDir, "instance-1")),
        makeAllEntry("wake-all-2", join(tempDir, "instance-2")),
      ]);
      mkdirSync(join(tempDir, "instance-1"), { recursive: true });
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

      // Both assistants attempted their starts; only the first's CES spawn
      // failed, and the loop moved on to start the healthy one fully.
      expect(startCesMock).toHaveBeenCalledTimes(2);
      expect(startLocalDaemonMock).toHaveBeenCalledTimes(2);
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
        for (const flag of ["--foreground"]) {
          process.argv = ["bun", "cadet", "wake", "--all", flag];
          await expect(wake()).rejects.toThrow("process.exit:1");
        }
      } finally {
        exitSpy.mockRestore();
      }

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("--all cannot be combined with --foreground"),
      );
    });
  });
});
