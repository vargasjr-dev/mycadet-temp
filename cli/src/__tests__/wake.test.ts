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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as assistantConfig from "../lib/assistant-config.js";
import * as localModeModule from "@mycadet/local-mode";
import * as docker from "../lib/remotes/docker.js";
import * as ngrok from "../lib/tunnels/ngrok.js";
import * as nginxIngress from "../lib/servers/nginx.js";
import * as rootSigningKey from "../lib/root-signing-key.js";
import type { LockfileAssistant } from "@mycadet/local-mode/contract";

const realAssistantConfig = { ...assistantConfig };
const realLocalMode = { ...localModeModule };
const realDocker = { ...docker };
const realNgrok = { ...ngrok };
const realRootSigningKey = { ...rootSigningKey };

const resolveTargetAssistantMock =
  mock<typeof assistantConfig.resolveTargetAssistant>();
const loadAllAssistantsMock = mock<typeof localModeModule.loadAllAssistants>(
  () => [],
);
const saveLockfileAssistantMock = mock<
  typeof localModeModule.saveLockfileAssistant
>(() => ({ ok: true, lockfile: { assistants: [], activeAssistant: null } }));

mock.module("../lib/assistant-config.js", () => ({
  ...realAssistantConfig,
  resolveTargetAssistant: resolveTargetAssistantMock,
}));

const wakeLocalMock = mock<typeof localModeModule.wakeLocal>(async () => ({
  ok: true,
}));
const wakeDockerMock = mock<typeof localModeModule.wakeDocker>(async () => ({
  ok: true,
}));
const dockerResourceNamesMock = mock<
  typeof localModeModule.dockerResourceNames
>(localModeModule.dockerResourceNames);
const recreateDockerContainersMock = mock<
  typeof docker.recreateDockerContainers
>(async () => {});
const waitForDaemonReadyMock = mock<typeof localModeModule.waitForDaemonReady>(
  async () => true,
);
const isIngressRunningMock = mock<typeof localModeModule.isIngressRunning>(
  () => false,
);
const readIngressStateMock = mock<typeof localModeModule.readIngressState>(
  () => null,
);


mock.module("@mycadet/local-mode", () => ({
  ...realLocalMode,
  saveLockfileAssistant: saveLockfileAssistantMock,
  loadAllAssistants: loadAllAssistantsMock,
  wakeLocal: wakeLocalMock,
  wakeDocker: wakeDockerMock,
  dockerResourceNames: dockerResourceNamesMock,
  waitForDaemonReady: waitForDaemonReadyMock,
  isIngressRunning: isIngressRunningMock,
  readIngressState: readIngressStateMock,
}));
mock.module("../lib/remotes/docker.js", () => ({
  ...realDocker,
  recreateDockerContainers: recreateDockerContainersMock,
}));

// Defaults to the real writer: repair tests assert the key file's contents.
const persistRootSigningKeyMock = mock<
  typeof rootSigningKey.persistRootSigningKey
>(realRootSigningKey.persistRootSigningKey);

mock.module("../lib/root-signing-key.js", () => ({
  ...realRootSigningKey,
  persistRootSigningKey: persistRootSigningKeyMock,
}));

const ngrokRunMock = mock<typeof ngrok.runNgrokTunnel>(async () => ({
  publicUrl: "https://tunnel.example.com",
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
mock.module("../lib/servers/nginx.js", () => ({
  ...realNginxIngress,
  ensureAppServer: ensureAppServerMock,
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
  wakeLocalMock.mockReset();
  wakeLocalMock.mockResolvedValue({ ok: true });
  wakeDockerMock.mockReset();
  wakeDockerMock.mockResolvedValue({ ok: true });
  dockerResourceNamesMock.mockReset();
  dockerResourceNamesMock.mockImplementation(
    localModeModule.dockerResourceNames,
  );
  recreateDockerContainersMock.mockReset();
  recreateDockerContainersMock.mockResolvedValue(undefined);
  waitForDaemonReadyMock.mockReset();
  waitForDaemonReadyMock.mockResolvedValue(true);
  persistRootSigningKeyMock.mockReset();
  persistRootSigningKeyMock.mockImplementation(
    realRootSigningKey.persistRootSigningKey,
  );
  ngrokRunMock.mockReset();
  ngrokRunMock.mockImplementation(async () => ({
    publicUrl: "https://tunnel.example.com",
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
  mock.module("../lib/tunnels/ngrok", () => realNgrok);
  mock.module("../lib/servers/nginx.js", () => realNginxIngress);
  mock.module("../lib/root-signing-key.js", () => realRootSigningKey);
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
      ...(publicUrl ? { publicUrl: publicUrl } : {}),
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
    // The v0.0.10 run feedback: the containers were never created — the
    // docker leg answers its structured 404, the command recreates.
    wakeDockerMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      error:
        "the containers for 'docker-1' don't exist yet — run `cadet wake` once to recreate them from the recorded images",
    });
    process.argv = ["bun", "cadet", "wake", "docker-1"];

    try {
      await wake();

      expect(recreateDockerContainersMock).toHaveBeenCalledWith(migratedEntry);
      expect(logSpy).toHaveBeenCalledWith("Docker containers started.");
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
    const waitForDaemonReadyMock = spyOn(
      localModeModule,
      "waitForDaemonReady",
    ).mockImplementation(async () => true);
    process.argv = ["bun", "cadet", "wake", "docker-1"];

    try {
      await wake();

      expect(waitForDaemonReadyMock).toHaveBeenCalledWith(7930, 5 * 60_000);
      expect(ensureAppServerMock).toHaveBeenCalled();
    } finally {
      waitForDaemonReadyMock.mockRestore();
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
    const waitForDaemonReadyMock = spyOn(
      localModeModule,
      "waitForDaemonReady",
    ).mockImplementation(async () => false);
    process.argv = ["bun", "cadet", "wake", "docker-1"];

    try {
      await wake();

      expect(ensureAppServerMock).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("did not come up"),
      );
      expect(logSpy).toHaveBeenCalledWith("Wake complete.");
    } finally {
      waitForDaemonReadyMock.mockRestore();
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
    const waitForDaemonReadyMock = spyOn(
      localModeModule,
      "waitForDaemonReady",
    ).mockImplementation(async () => true);
    process.argv = ["bun", "cadet", "wake", "docker-1"];

    try {
      await wake();

      expect(waitForDaemonReadyMock).not.toHaveBeenCalled();
      expect(ensureAppServerMock).not.toHaveBeenCalled();
    } finally {
      waitForDaemonReadyMock.mockRestore();
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
      } as LockfileAssistant,
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
});

describe("cadet wake --all", () => {
  function makeAllEntry(
    assistantId: string,
    instanceDir: string,
  ): LockfileAssistant {
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
    return [
      makeAllEntry("wake-all-1", join(tempDir, "instance-1")),
      makeAllEntry("wake-all-2", join(tempDir, "instance-2")),
    ];
  }

  test("starts every assistant in the lockfile", async () => {
    loadAllAssistantsMock.mockReturnValue(makeAllEntries());
    process.argv = ["bun", "cadet", "wake", "--all"];

    await wake();

    expect(wakeLocalMock).toHaveBeenCalledTimes(2);
    expect(
      (wakeLocalMock.mock.calls[0]![0] as LockfileAssistant).assistantId,
    ).toBe("wake-all-1");
    expect(
      (wakeLocalMock.mock.calls[1]![0] as LockfileAssistant).assistantId,
    ).toBe("wake-all-2");
  });

  test("continues past a failing assistant and exits 1", async () => {
    // A real wake failure for the first entry; the loop still wakes the rest.
    wakeLocalMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      error: "ces spawn failed",
    });
    loadAllAssistantsMock.mockReturnValue(makeAllEntries());
    process.argv = ["bun", "cadet", "wake", "--all"];

    const exitSpy = spyOn(process, "exit").mockImplementation(
      (code?: number | string | undefined): never => {
        throw new Error(`process.exit:${code}`);
      },
    );

    try {
      await expect(wake()).rejects.toThrow("process.exit:1");
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("failed to wake 'wake-all-1'"),
      );
    } finally {
      exitSpy.mockRestore();
    }

    // Both assistants attempted their wakes.
    expect(wakeLocalMock).toHaveBeenCalledTimes(2);
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

  test("refuses --all with --foreground", async () => {
    const exitSpy = spyOn(process, "exit").mockImplementation(
      (code?: number | string | undefined): never => {
        throw new Error(`process.exit:${code}`);
      },
    );

    try {
      process.argv = ["bun", "cadet", "wake", "--all", "--foreground"];
      await expect(wake()).rejects.toThrow("process.exit:1");
    } finally {
      exitSpy.mockRestore();
    }

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("--all cannot be combined with --foreground"),
    );
  });
});
