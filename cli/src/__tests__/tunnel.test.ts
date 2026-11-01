import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import * as childProcess from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
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

import { TUNNEL_PROVIDERS } from "@mycadet/service-contracts/ingress";

import * as cloudflareTunnel from "../lib/tunnels/cloudflare.js";
import * as gatewayNotify from "../lib/tunnels/gateway-notify.js";
import * as ngrok from "../lib/tunnels/ngrok.js";
import * as nginxIngress from "../lib/servers/nginx.js";
import * as localModeModule from "@mycadet/local-mode";
import * as tailscaleTunnel from "../lib/tunnels/tailscale.js";
import {
  readRootProcesses,
  stampRootProcess,
} from "../lib/assistant-config.js";
import { getLocalInstanceDir } from "@mycadet/local-mode";
import type {
  LocalAssistant,
  LockfileAssistant,
} from "@mycadet/local-mode/contract";
import { withPreconnect } from "./helpers/http.js";

const realCloudflareTunnel = { ...cloudflareTunnel };
const realGatewayNotify = { ...gatewayNotify };
const realNgrok = { ...ngrok };
const realNginxIngress = { ...nginxIngress };
const realTailscaleTunnel = { ...tailscaleTunnel };
const realChildProcess = { ...childProcess };

/** What a mocked provider run hands back: the URL it established or adopted. */
const fakeTunnelResult = (publicUrl: string) => ({
  publicUrl,
});

const runCloudflareTunnelMock = mock<
  typeof cloudflareTunnel.runCloudflareTunnel
>(async () => fakeTunnelResult("https://test.example.cloudflare.dev"));
mock.module("../lib/tunnels/cloudflare.js", () => ({
  ...realCloudflareTunnel,
  runCloudflareTunnel: runCloudflareTunnelMock,
  CLOUDFLARE_PROVIDER: {
    ...realCloudflareTunnel.CLOUDFLARE_PROVIDER,
    run: runCloudflareTunnelMock,
  },
}));

const runNgrokTunnelMock = mock<typeof ngrok.runNgrokTunnel>(async () =>
  fakeTunnelResult("https://test.example.ngrok.dev"),
);
mock.module("../lib/tunnels/ngrok", () => ({
  ...realNgrok,
  runNgrokTunnel: runNgrokTunnelMock,
  NGROK_PROVIDER: { ...realNgrok.NGROK_PROVIDER, run: runNgrokTunnelMock },
}));

const runTailscaleTunnelMock = mock<typeof tailscaleTunnel.runTailscaleTunnel>(
  async () => fakeTunnelResult("https://test-machine.tailnet.ts.net"),
);
mock.module("../lib/tunnels/tailscale.js", () => ({
  ...realTailscaleTunnel,
  runTailscaleTunnel: runTailscaleTunnelMock,
  TAILSCALE_PROVIDER: {
    ...realTailscaleTunnel.TAILSCALE_PROVIDER,
    run: runTailscaleTunnelMock,
  },
}));

const notifyGatewayOfPublicUrlMock = mock<
  typeof gatewayNotify.notifyGatewayOfPublicUrl
>(async () => {});
mock.module("../lib/tunnels/gateway-notify.js", () => ({
  ...realGatewayNotify,
  notifyGatewayOfPublicUrl: notifyGatewayOfPublicUrlMock,
}));

const EDGE_PORT = 18080;

const ensureAppServerMock = mock<typeof nginxIngress.ensureAppServer>(
  async () => ({
    port: EDGE_PORT,
    started: true,
  }),
);
const isIngressRunningMock = mock<typeof localModeModule.isIngressRunning>(
  () => false,
);
const readIngressStateMock = mock<typeof localModeModule.readIngressState>(
  () => null,
);
const getNginxVersionMock = mock<typeof nginxIngress.getNginxVersion>(
  () => "nginx version (test)",
);
mock.module("../lib/servers/nginx.js", () => ({
  ...realNginxIngress,
  ensureAppServer: ensureAppServerMock,
  getNginxVersion: getNginxVersionMock,
}));
mock.module("@mycadet/local-mode", () => ({
  ...localModeModule,
  // servers/nginx.ts no longer re-exports the ingress reads — the tunnel
  // flow imports them from the package, so mock them here.
  isIngressRunning: isIngressRunningMock,
  readIngressState: readIngressStateMock,
}));

const { tunnel } = await import("../commands/tunnel.js");

const originalArgv = [...process.argv];
const originalFetch = globalThis.fetch;
const originalConfigHome = process.env.XDG_CONFIG_HOME;
const originalWorkspaceDir = process.env.CADET_WORKSPACE_DIR;
const tempDirs: string[] = [];

function makeLocalEntry(assistantId = "assistant-1"): LocalAssistant {
  const instanceDir = mkdtempSync(join(tmpdir(), "cadet-tunnel-test-"));
  tempDirs.push(instanceDir);
  return {
    assistantId,
    cloud: "local",
    instanceDir,
    daemonPort: 7821,
    port: 7830,
    cesPort: 7822,
  };
}

function makeCloudEntry(assistantId = "cloud-1"): LockfileAssistant {
  return {
    assistantId,
    cloud: "cloud",
  };
}

/** A `hatch --remote docker` entry: local container gateway at its recorded port. */
function makeDockerEntry(assistantId = "docker-1"): LockfileAssistant {
  return {
    assistantId,
    cloud: "docker",
    port: 7930,
    daemonPort: 7821,
  };
}

/** A macOS-app-managed entry: the container rides the macOS app's socket. */
function makeAppleContainerEntry(assistantId = "apple-1"): LockfileAssistant {
  return {
    assistantId,
    cloud: "apple-container",
    port: 8030,
    daemonPort: 7821,
    mgmtSocket: "/tmp/fake-mgmt.sock",
  };
}

/**
 * Pin the default workspace and seed its config. The start flow's
 * webhook-integration guard reads the machine-level workspace under the
 * app-server-first contract, so start-flow tests seed there.
 */
function writeDefaultWorkspaceConfig(config: Record<string, unknown>): string {
  const workspaceDir = useTempDefaultWorkspaceDir();
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(
    join(workspaceDir, "config.json"),
    JSON.stringify(config, null, 2),
  );
  return workspaceDir;
}

/** Point the default workspace dir at a temp dir; returns that dir. */
function useTempDefaultWorkspaceDir(): string {
  const workspaceDir = mkdtempSync(join(tmpdir(), "cadet-tunnel-ws-"));
  tempDirs.push(workspaceDir);
  process.env.CADET_WORKSPACE_DIR = workspaceDir;
  return workspaceDir;
}

function writeLockfile(
  entryOrEntries: LockfileAssistant | LockfileAssistant[],
  activeAssistant?: string,
): void {
  const entries = Array.isArray(entryOrEntries)
    ? entryOrEntries
    : [entryOrEntries];
  // Write into the config home already steering this test when one is set;
  // otherwise carve out a throwaway config home of our own.
  let lockfileDir = process.env.XDG_CONFIG_HOME;
  if (!lockfileDir) {
    lockfileDir = mkdtempSync(join(tmpdir(), "cadet-tunnel-lockfile-"));
    tempDirs.push(lockfileDir);
    process.env.XDG_CONFIG_HOME = lockfileDir;
  }
  mkdirSync(join(lockfileDir, "cadet"), { recursive: true });
  writeFileSync(
    join(lockfileDir, "cadet", "lockfile.json"),
    JSON.stringify(
      {
        activeAssistant: activeAssistant ?? entries[0].assistantId,
        assistants: entries,
      },
      null,
      2,
    ),
  );
}

/** Run tunnel() expecting exit(1); returns the joined console.error output. */
async function runTunnelExpectingExit1(): Promise<{
  exited: boolean;
  errors: string;
}> {
  const errors: string[] = [];
  const errSpy = spyOn(console, "error").mockImplementation(
    (...a: unknown[]) => {
      errors.push(a.join(" "));
    },
  );
  const exitSpy = spyOn(process, "exit").mockImplementation(
    (code?: number | string | undefined): never => {
      throw new Error(`exit:${code}`);
    },
  );

  let exited = false;
  try {
    await tunnel();
  } catch (e) {
    exited = e instanceof Error && e.message === "exit:1";
  } finally {
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return { exited, errors: errors.join("\n") };
}

/** Run tunnel() capturing console.log output; returns the joined lines. */
async function runTunnelCapturingLogs(): Promise<string> {
  const logs: string[] = [];
  const logSpy = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logs.push(a.join(" "));
  });
  try {
    await tunnel();
  } finally {
    logSpy.mockRestore();
  }
  return logs.join("\n");
}

describe("app server targeting", () => {
  beforeEach(() => {
    process.argv = [
      "bun",
      "cadet",
      "tunnel",
      "start",
      "--provider",
      "tailscale",
    ];
    // The ngrok config file lives under the XDG config dir; a fresh one per
    // test keeps the saved-domain state hermetic. Set it before seeding the
    // lockfile so both land in the same config home.
    const configHome = mkdtempSync(join(tmpdir(), "cadet-tunnel-xdg-"));
    tempDirs.push(configHome);
    process.env.XDG_CONFIG_HOME = configHome;
    writeLockfile(makeLocalEntry());
    globalThis.fetch = withPreconnect(async () => {
      throw new Error("gateway unavailable");
    });
    runCloudflareTunnelMock.mockReset();
    runCloudflareTunnelMock.mockResolvedValue(
      fakeTunnelResult("https://test.example.cloudflare.dev"),
    );
    runNgrokTunnelMock.mockReset();
    runNgrokTunnelMock.mockResolvedValue(
      fakeTunnelResult("https://test.example.ngrok.dev"),
    );
    runTailscaleTunnelMock.mockReset();
    runTailscaleTunnelMock.mockResolvedValue(
      fakeTunnelResult("https://test-machine.tailnet.ts.net"),
    );
    notifyGatewayOfPublicUrlMock.mockReset();
    ensureAppServerMock.mockReset();
    ensureAppServerMock.mockResolvedValue({
      port: EDGE_PORT,
      started: true,
    });
  });

  afterEach(() => {
    process.argv = originalArgv;
    globalThis.fetch = originalFetch;
    rmSync(realNgrok.ngrokConfigPath(), { force: true });
    if (originalConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalConfigHome;
    }
    if (originalWorkspaceDir === undefined) {
      delete process.env.CADET_WORKSPACE_DIR;
    } else {
      process.env.CADET_WORKSPACE_DIR = originalWorkspaceDir;
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  afterAll(() => {
    mock.module("../lib/tunnels/cloudflare.js", () => realCloudflareTunnel);
    mock.module("../lib/tunnels/ngrok", () => realNgrok);
    mock.module("../lib/tunnels/tailscale.js", () => realTailscaleTunnel);
    mock.module("../lib/servers/nginx.js", () => realNginxIngress);
    mock.module("@mycadet/local-mode", () => localModeModule);
  });

  test("targets the edge port returned by ensureAppServer for ngrok", async () => {
    const entry = makeLocalEntry();
    writeLockfile(entry);
    process.argv = ["bun", "cadet", "tunnel", "start", "--provider", "ngrok"];

    const logs = await runTunnelCapturingLogs();
    expect(ensureAppServerMock).toHaveBeenCalledWith();
    expect(runNgrokTunnelMock).toHaveBeenCalledWith({ port: EDGE_PORT });
    expect(runCloudflareTunnelMock).not.toHaveBeenCalled();
    expect(logs).toContain(`Started the nginx edge on 127.0.0.1:${EDGE_PORT}`);
  });

  test("the tunnel level notifies every local gateway of the public URL", async () => {
    const second = makeLocalEntry("assistant-2");
    writeLockfile([makeLocalEntry(), second]);
    process.argv = ["bun", "cadet", "tunnel", "start", "--provider", "ngrok"];

    await runTunnelCapturingLogs();

    // The provider hands its URL back; the notification is the tunnel
    // level's job, and the domain is app-global info — every locally
    // reachable assistant's gateway hears it, not just the edge's front.
    expect(notifyGatewayOfPublicUrlMock).toHaveBeenCalledWith(
      "https://test.example.ngrok.dev",
      "assistant-1",
    );
    expect(notifyGatewayOfPublicUrlMock).toHaveBeenCalledWith(
      "https://test.example.ngrok.dev",
      "assistant-2",
    );
  });

  test("an active cloud assistant still tunnels the edge", async () => {
    const cloud = makeCloudEntry();
    writeLockfile([cloud, makeLocalEntry()], cloud.assistantId);
    process.argv = ["bun", "cadet", "tunnel", "start", "--provider", "ngrok"];

    const logs = await runTunnelCapturingLogs();
    expect(logs).not.toContain("Tunneling the local assistant");
    expect(ensureAppServerMock).toHaveBeenCalledWith();
    expect(runNgrokTunnelMock).toHaveBeenCalledWith({ port: EDGE_PORT });
  });

  test("a docker assistant set active tunnels the edge port", async () => {
    const local = makeLocalEntry();
    writeLockfile(
      [
        local,
        {
          assistantId: "docker-1",
          cloud: "docker",
          port: 7930,
          daemonPort: 7821,
        },
      ],
      "docker-1",
    );
    process.argv = ["bun", "cadet", "tunnel", "start", "--provider", "ngrok"];

    await runTunnelCapturingLogs();

    expect(ensureAppServerMock).toHaveBeenCalledWith();
    expect(runNgrokTunnelMock).toHaveBeenCalledWith({ port: EDGE_PORT });
  });

  test("an active docker assistant tunnels on a bare invocation", async () => {
    const docker = makeDockerEntry();
    writeLockfile(docker, docker.assistantId);
    process.argv = ["bun", "cadet", "tunnel", "start", "--provider", "ngrok"];

    await runTunnelCapturingLogs();

    expect(ensureAppServerMock).toHaveBeenCalledWith();
    expect(runNgrokTunnelMock).toHaveBeenCalledWith({ port: EDGE_PORT });
  });

  test("an active cloud assistant with no local entries still tunnels the edge", async () => {
    // The regression shape: nothing locally managed anywhere in the lockfile,
    // yet the tunnel fronts the app server — the machine-level edge resolves
    // whatever it fronts, and no assistant classification gates the start.
    writeLockfile(makeCloudEntry());
    process.argv = ["bun", "cadet", "tunnel", "start", "--provider", "ngrok"];

    const logs = await runTunnelCapturingLogs();
    expect(ensureAppServerMock).toHaveBeenCalledWith();
    expect(runNgrokTunnelMock).toHaveBeenCalledWith({ port: EDGE_PORT });
    expect(logs).toContain(`Started the nginx edge on 127.0.0.1:${EDGE_PORT}`);
  });

  test("a stray positional errors pointing at the subcommands", async () => {
    const local = makeLocalEntry();
    writeLockfile([makeCloudEntry(), local], local.assistantId);
    process.argv = [
      "bun",
      "cadet",
      "tunnel",
      "start",
      "cloud-1",
      "--provider",
      "ngrok",
    ];

    const { exited, errors } = await runTunnelExpectingExit1();

    expect(exited).toBe(true);
    expect(errors).toContain("takes no assistant name");
    expect(ensureAppServerMock).not.toHaveBeenCalled();
    expect(runNgrokTunnelMock).not.toHaveBeenCalled();
  });

  test("an apple-container assistant set active tunnels the edge port", async () => {
    const local = makeLocalEntry();
    writeLockfile([local, makeAppleContainerEntry()], "apple-1");
    process.argv = ["bun", "cadet", "tunnel", "start", "--provider", "ngrok"];

    await runTunnelCapturingLogs();

    expect(ensureAppServerMock).toHaveBeenCalledWith();
    expect(runNgrokTunnelMock).toHaveBeenCalledWith({ port: EDGE_PORT });
  });

  test("targets the edge port for cloudflare", async () => {
    const entry = makeLocalEntry();
    writeLockfile(entry);
    process.argv = [
      "bun",
      "cadet",
      "tunnel",
      "start",
      "--provider",
      "cloudflare",
    ];

    await runTunnelCapturingLogs();

    expect(runCloudflareTunnelMock).toHaveBeenCalledWith({ port: EDGE_PORT });
    expect(runNgrokTunnelMock).not.toHaveBeenCalled();
  });

  test("targets the edge port for tailscale and notes a reused edge", async () => {
    const entry = makeLocalEntry();
    writeLockfile(entry);
    process.argv = [
      "bun",
      "cadet",
      "tunnel",
      "start",
      "--provider",
      "tailscale",
    ];
    ensureAppServerMock.mockResolvedValue({
      port: EDGE_PORT,
      started: false,
    });

    const logs = await runTunnelCapturingLogs();

    expect(runTailscaleTunnelMock).toHaveBeenCalledWith({ port: EDGE_PORT });
    expect(logs).toContain(`Reusing the nginx edge on 127.0.0.1:${EDGE_PORT}`);
  });

  test("a bare invocation tunnels the default provider", async () => {
    const entry = makeLocalEntry();
    writeLockfile(entry);
    process.argv = ["bun", "cadet", "tunnel", "start"];

    const logs = await runTunnelCapturingLogs();

    expect(logs).toContain("Using the default provider: ngrok");
    expect(runNgrokTunnelMock).toHaveBeenCalledWith({ port: EDGE_PORT });
    expect(ensureAppServerMock).toHaveBeenCalled();
    expect(runTailscaleTunnelMock).not.toHaveBeenCalled();
    expect(runCloudflareTunnelMock).not.toHaveBeenCalled();
  });

  test("--provider tailscale fronts the edge with the lockfile's active assistant", async () => {
    const entry = makeLocalEntry();
    writeLockfile(entry);
    process.argv = [
      "bun",
      "cadet",
      "tunnel",
      "start",
      "--provider",
      "tailscale",
    ];

    await runTunnelCapturingLogs();

    expect(runTailscaleTunnelMock).toHaveBeenCalledWith({ port: EDGE_PORT });
  });

  test("ngrok fronts the edge with the lockfile's active assistant", async () => {
    const entry = makeLocalEntry();
    writeLockfile(entry);
    process.argv = ["bun", "cadet", "tunnel", "start", "--provider", "ngrok"];

    await runTunnelCapturingLogs();

    expect(runNgrokTunnelMock).toHaveBeenCalledWith({ port: EDGE_PORT });
  });

  test("missing nginx aborts before any provider spawn", async () => {
    process.argv = ["bun", "cadet", "tunnel", "start", "--provider", "ngrok"];
    ensureAppServerMock.mockRejectedValue(
      new Error(
        "nginx is not installed, so the app server cannot start. " +
          "See https://nginx.org/en/docs/install.html for how to install, " +
          "or point NGINX_BIN at an existing binary.",
      ),
    );

    const { exited, errors } = await runTunnelExpectingExit1();

    expect(exited).toBe(true);
    expect(errors).toContain(
      "See https://nginx.org/en/docs/install.html for how to install",
    );
    expect(runNgrokTunnelMock).not.toHaveBeenCalled();
    expect(runCloudflareTunnelMock).not.toHaveBeenCalled();
    expect(runTailscaleTunnelMock).not.toHaveBeenCalled();
  });

  test("rejects an unknown --provider with a stale-CLI hint", async () => {
    process.argv = ["bun", "cadet", "tunnel", "start", "--provider", "bogus"];

    const { exited, errors } = await runTunnelExpectingExit1();

    expect(exited).toBe(true);
    expect(errors).toContain("unknown tunnel provider 'bogus'");
    expect(errors).toContain("your CLI may be out of date");
    expect(errors).toContain("bun install -g cadet@latest");
    expect(runNgrokTunnelMock).not.toHaveBeenCalled();
    expect(runCloudflareTunnelMock).not.toHaveBeenCalled();
  });

  test("accepts every provider in the shared registry", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      for (const provider of TUNNEL_PROVIDERS) {
        writeLockfile(makeLocalEntry());
        process.argv = [
          "bun",
          "cadet",
          "tunnel",
          "start",
          "--provider",
          provider,
        ];

        const { exited, errors } = await runTunnelExpectingExit1();

        expect(exited).toBe(false);
        expect(errors).not.toContain("unknown tunnel provider");
      }
    } finally {
      logSpy.mockRestore();
    }
  });

  test("threads --domain through to runNgrokTunnel", async () => {
    const entry = makeLocalEntry();
    writeLockfile(entry);
    process.argv = [
      "bun",
      "cadet",
      "tunnel",
      "start",
      "--provider",
      "ngrok",
      "--domain",
      "foo.ngrok.app",
    ];

    await runTunnelCapturingLogs();

    expect(runNgrokTunnelMock).toHaveBeenCalledWith({
      port: EDGE_PORT,
      domain: "foo.ngrok.app",
    });
  });

  test("rejects --domain with a non-ngrok provider", async () => {
    process.argv = [
      "bun",
      "cadet",
      "tunnel",
      "start",
      "--provider",
      "cloudflare",
      "--domain",
      "foo.ngrok.app",
    ];

    const { exited, errors } = await runTunnelExpectingExit1();

    expect(exited).toBe(true);
    expect(errors).toContain(
      "--domain is not supported with --provider cloudflare",
    );
    expect(runNgrokTunnelMock).not.toHaveBeenCalled();
    expect(runCloudflareTunnelMock).not.toHaveBeenCalled();
  });

  test("--clear-domain drops the saved domain and runs domainless", async () => {
    const entry = makeLocalEntry();
    writeLockfile(entry);
    const workspaceDir = useTempDefaultWorkspaceDir();
    mkdirSync(workspaceDir, { recursive: true });
    realNgrok.saveNgrokDomain("dead.ngrok.app");
    process.argv = [
      "bun",
      "cadet",
      "tunnel",
      "start",
      "--provider",
      "ngrok",
      "--clear-domain",
    ];

    const logs = await runTunnelCapturingLogs();

    expect(logs).toContain("Cleared the saved reserved domain");
    // The saved domain lives in the XDG ngrok config, not the workspace config.
    expect(realNgrok.loadNgrokDomain()).toBeNull();
    // The run proceeds domainless: no `domain` key reaches runNgrokTunnel.
    expect(runNgrokTunnelMock).toHaveBeenCalledWith({ port: EDGE_PORT });
  });

  test("rejects --clear-domain combined with --domain", async () => {
    process.argv = [
      "bun",
      "cadet",
      "tunnel",
      "start",
      "--provider",
      "ngrok",
      "--domain",
      "foo.ngrok.app",
      "--clear-domain",
    ];

    const { exited, errors } = await runTunnelExpectingExit1();

    expect(exited).toBe(true);
    expect(errors).toContain("--clear-domain cannot be combined with --domain");
    expect(runNgrokTunnelMock).not.toHaveBeenCalled();
  });

  test("rejects --clear-domain with a non-ngrok provider", async () => {
    process.argv = [
      "bun",
      "cadet",
      "tunnel",
      "start",
      "--provider",
      "cloudflare",
      "--clear-domain",
    ];

    const { exited, errors } = await runTunnelExpectingExit1();

    expect(exited).toBe(true);
    expect(errors).toContain(
      "--clear-domain is not supported with --provider cloudflare",
    );
    expect(runNgrokTunnelMock).not.toHaveBeenCalled();
    expect(runCloudflareTunnelMock).not.toHaveBeenCalled();
  });

  test("errors when --domain is missing its value", async () => {
    process.argv = [
      "bun",
      "cadet",
      "tunnel",
      "start",
      "--provider",
      "ngrok",
      "--domain",
    ];

    const { exited, errors } = await runTunnelExpectingExit1();

    expect(exited).toBe(true);
    expect(errors).toContain("--domain requires a value");
    expect(runNgrokTunnelMock).not.toHaveBeenCalled();
  });

  test("a not-yet-implemented provider error carries the stale-CLI hint", async () => {
    // `cadet` stays valid-but-unimplemented, so it hits this path rather
    // than the unknown-provider one.
    process.argv = ["bun", "cadet", "tunnel", "start", "--provider", "cadet"];

    let err: Error | undefined;
    try {
      await tunnel();
    } catch (e) {
      err = e instanceof Error ? e : undefined;
    }

    expect(err?.message).toContain("is not yet implemented");
    expect(err?.message).toContain("your CLI may be out of date");
    expect(err?.message).toContain("bun install -g cadet@latest");
    expect(ensureAppServerMock).not.toHaveBeenCalled();
    expect(runNgrokTunnelMock).not.toHaveBeenCalled();
    expect(runCloudflareTunnelMock).not.toHaveBeenCalled();
  });
});

describe("ngrok --domain spawn args", () => {
  const originalContainerized = process.env.IS_CONTAINERIZED;
  let lastChild: ChildProcess | null = null;
  // Stand-in for the user's default ngrok config — where their authtoken
  // lives — that `ngrok config check` resolves for layered second-agent
  // spawns.
  let defaultNgrokConfigPath = "";

  const spawnMock = mock(
    (
      _command: string,
      _args: readonly string[],
      _options?: SpawnOptions,
    ): ChildProcess => {
      const child = new realChildProcess.ChildProcess();
      // kill() stays stubbed: the fake pid must never be signaled for real.
      // stdout/stderr: the real class resolves them through a getter over the
      // internal spawn handle, so null-shadow them via defineProperty — an
      // Object.assign [[Set]] through the getter-only accessor throws.
      Object.defineProperty(child, "stdout", { value: null });
      Object.defineProperty(child, "stderr", { value: null });
      const fake = Object.assign(child, { pid: 4242, kill: () => true });
      lastChild = fake;
      return fake;
    },
  );
  const execFileSyncMock = mock(
    (_cmd: string, args: readonly string[]): string =>
      args[0] === "config"
        ? `Valid configuration file at ${defaultNgrokConfigPath}`
        : "ngrok version 3.9.0",
  );

  beforeAll(() => {
    mock.module("node:child_process", () => ({
      ...realChildProcess,
      spawn: spawnMock,
      execFileSync: execFileSyncMock,
    }));
  });

  afterAll(() => {
    mock.module("node:child_process", () => realChildProcess);
  });

  beforeEach(() => {
    spawnMock.mockClear();
    lastChild = null;
    delete process.env.IS_CONTAINERIZED;
    // The ngrok config file lives under the XDG config dir; a fresh one per
    // test keeps the saved-domain state hermetic.
    const configHome = mkdtempSync(join(tmpdir(), "cadet-ngrok-xdg-"));
    tempDirs.push(configHome);
    process.env.XDG_CONFIG_HOME = configHome;
    defaultNgrokConfigPath = join(configHome, "user-ngrok-default.yml");
    writeFileSync(
      defaultNgrokConfigPath,
      "authtoken: test-token-for-layered-spawn\n",
    );
    mockNgrokApiFetch([null]);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    rmSync(realNgrok.ngrokConfigPath(), { force: true });
    if (originalConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalConfigHome;
    }
    if (originalContainerized === undefined) {
      delete process.env.IS_CONTAINERIZED;
    } else {
      process.env.IS_CONTAINERIZED = originalContainerized;
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeWorkspace(config: Record<string, unknown>): string {
    const ws = mkdtempSync(join(tmpdir(), "cadet-ngrok-domain-test-"));
    // The provider resolves the machine-level workspace itself.
    process.env.CADET_WORKSPACE_DIR = ws;
    tempDirs.push(ws);
    writeFileSync(join(ws, "config.json"), JSON.stringify(config, null, 2));
    return ws;
  }

  interface StubTunnel {
    public_url: string;
    config: { addr: string };
  }

  /**
   * ngrok local API stub replaying one response per call, last one repeated.
   * A `null` entry means the API is unreachable — no agent on that address —
   * as opposed to `{ tunnels: [] }`, which is a live agent with no tunnels.
   */
  function mockNgrokApiFetch(
    responses: ({ tunnels: StubTunnel[] } | null)[],
  ): void {
    let call = 0;
    globalThis.fetch = withPreconnect(async () => {
      const body = responses[Math.min(call, responses.length - 1)];
      call++;
      if (body === null) throw new Error("connection refused");
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
  }

  function readTunnelRecord(): Record<string, unknown> {
    const path = join(process.env.XDG_CONFIG_HOME!, "cadet", "lockfile.json");
    if (!existsSync(path)) return {};
    const lockfile = JSON.parse(readFileSync(path, "utf-8")) as {
      tunnel?: Record<string, unknown>;
    };
    return lockfile.tunnel ?? {};
  }

  /** Run `fn` against a throwaway lockfile holding one local entry. */
  async function withLockfileFor<T>(
    assistantId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    // Write into the config home already steering this test when one is set;
    // otherwise carve out a throwaway config home of our own.
    let lockfileDir = process.env.XDG_CONFIG_HOME;
    if (!lockfileDir) {
      lockfileDir = mkdtempSync(join(tmpdir(), "cadet-ngrok-lockfile-"));
      tempDirs.push(lockfileDir);
      process.env.XDG_CONFIG_HOME = lockfileDir;
    }
    mkdirSync(join(lockfileDir, "cadet"), { recursive: true });
    writeFileSync(
      join(lockfileDir, "cadet", "lockfile.json"),
      JSON.stringify({
        activeAssistant: assistantId,
        assistants: [
          { assistantId, runtimeUrl: "http://127.0.0.1:7830", cloud: "local" },
        ],
      }),
    );
    return await fn();
  }

  const unrelatedPortTunnel: StubTunnel = {
    public_url: "https://unrelated.ngrok.app",
    config: { addr: "localhost:65500" },
  };

  test("runNgrokTunnel spawns ngrok with --domain and persists the domain", async () => {
    makeWorkspace({});
    // The pre-spawn listing is empty (any running tunnel would abort the run);
    // post-spawn, only the tunnel matching the target port and domain may be
    // saved even with an unrelated-port tunnel listed first.
    mockNgrokApiFetch([
      null,
      {
        tunnels: [
          unrelatedPortTunnel,
          {
            public_url: "https://foo.ngrok.app",
            config: { addr: "localhost:7831" },
          },
        ],
      },
    ]);

    const run = realNgrok.runNgrokTunnel({
      port: 7831,
      domain: "foo.ngrok.app",
    });
    // runNgrokTunnel blocks until the ngrok process exits; pump exit events
    // until its final exit listener is registered and the promise settles.
    const pump = setInterval(() => lastChild?.emit("exit", 0), 10);
    try {
      await run;
    } finally {
      clearInterval(pump);
    }

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnMock.mock.calls[0];
    expect(cmd).toBe("ngrok");
    // Plain `ngrok http` so the user's default config — where their
    // authtoken lives — is what the agent loads.
    expect(args).toEqual([
      "http",
      "127.0.0.1:7831",
      "--log=stdout",
      "--domain=foo.ngrok.app",
    ]);
    expect(realNgrok.loadNgrokDomain()).toBe("foo.ngrok.app");

    expect(readTunnelRecord()).toMatchObject({
      provider: "ngrok",
      publicUrl: "https://foo.ngrok.app",
    });
  });

  function mockTunnelListFetch(publicUrl: string, addr: string): void {
    globalThis.fetch = withPreconnect(
      async () =>
        new Response(
          JSON.stringify({
            tunnels: [{ public_url: publicUrl, config: { addr } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
  }

  test("runNgrokTunnel rejects an existing tunnel that mismatches the requested domain", async () => {
    makeWorkspace({});
    mockTunnelListFetch("https://other.ngrok-free.app", "localhost:7831");

    const errors: string[] = [];
    const errSpy = spyOn(console, "error").mockImplementation(
      (...a: unknown[]) => {
        errors.push(a.join(" "));
      },
    );
    const exitSpy = spyOn(process, "exit").mockImplementation(
      (code?: number | string | undefined): never => {
        throw new Error(`exit:${code}`);
      },
    );

    try {
      await expect(
        realNgrok.runNgrokTunnel({
          port: 7831,
          domain: "foo.ngrok.app",
        }),
      ).rejects.toThrow("does not match the requested domain 'foo.ngrok.app'");
    } finally {
      errSpy.mockRestore();
      exitSpy.mockRestore();
    }

    const combined = errors.join("\n");
    expect(combined).toContain("https://other.ngrok-free.app");
    expect(combined).toContain(
      "does not match the requested domain 'foo.ngrok.app'",
    );
    expect(combined).toContain("Stop the existing ngrok agent");
    expect(spawnMock).not.toHaveBeenCalled();

    // Nothing is recorded: the rejected agent is not blessed as ours.
    expect(readTunnelRecord()).toEqual({});
  });

  test("runNgrokTunnel adopts an existing tunnel that matches the requested domain", async () => {
    makeWorkspace({});
    mockTunnelListFetch("https://foo.ngrok.app", "localhost:7831");

    const run = realNgrok.runNgrokTunnel({
      port: 7831,
      domain: "foo.ngrok.app",
    });
    // The adopt path blocks until SIGINT/SIGTERM; pump SIGINT until the
    // listener is registered and the promise settles. Earlier tests leak
    // SIGINT handlers that call process.exit, so no-op it while pumping.
    // LOAD-BEARING cast: a no-op exit can't honestly be typed `: never` — it
    // must return so leaked SIGINT handlers can't crash the pump below.
    const exitSpy = spyOn(process, "exit").mockImplementation(
      (() => undefined) as never,
    );
    const pump = setInterval(() => process.emit("SIGINT"), 10);
    try {
      await run;
    } finally {
      clearInterval(pump);
      exitSpy.mockRestore();
    }

    expect(spawnMock).not.toHaveBeenCalled();
    expect(readTunnelRecord()).toMatchObject({
      provider: "ngrok",
      publicUrl: "https://foo.ngrok.app",
    });
    expect(realNgrok.loadNgrokDomain()).toBe("foo.ngrok.app");
  });

  test("runNgrokTunnel rejects a mismatched existing tunnel without adopting or spawning", async () => {
    makeWorkspace({});
    realNgrok.saveNgrokDomain("foo.ngrok.app");
    mockTunnelListFetch("https://other.ngrok-free.app", "localhost:7830");

    await expect(realNgrok.runNgrokTunnel({ port: 7830 })).rejects.toThrow(
      "does not match",
    );

    expect(spawnMock).not.toHaveBeenCalled();

    // The mismatched tunnel is not recorded as ours…
    expect(readTunnelRecord()).toEqual({});
    // …and the reserved domain stays saved as standing intent.
    expect(realNgrok.loadNgrokDomain()).toBe("foo.ngrok.app");
  });

  test("an adopted tunnel records the url it serves", async () => {
    makeWorkspace({});
    mockTunnelListFetch("https://adopted.ngrok.app", "localhost:7830");

    await withLockfileFor("adopt-assistant", () =>
      realNgrok.runNgrokTunnel({
        port: 7830,
      }),
    );

    expect(spawnMock).not.toHaveBeenCalled();
    expect(readTunnelRecord()).toMatchObject({
      provider: "ngrok",
      publicUrl: "https://adopted.ngrok.app",
    });
  });

  test("a spawned tunnel records the url it serves", async () => {
    makeWorkspace({});
    mockNgrokApiFetch([
      null,
      {
        tunnels: [
          {
            public_url: "https://spawned.ngrok.app",
            config: { addr: "localhost:7830" },
          },
        ],
      },
    ]);

    const run = withLockfileFor("spawn-assistant", () =>
      realNgrok.runNgrokTunnel({
        port: 7830,
      }),
    );
    const pump = setInterval(() => lastChild?.emit("exit", 0), 10);
    try {
      await run;
    } finally {
      clearInterval(pump);
    }

    expect(readTunnelRecord()).toMatchObject({
      provider: "ngrok",
      publicUrl: "https://spawned.ngrok.app",
    });
  });

  test("runNgrokTunnel starts a second agent when the first tunnels a different port", async () => {
    makeWorkspace({});
    // Discovery sees the stale agent; the poll of the second agent's own API
    // then reports the tunnel for the requested port.
    mockNgrokApiFetch([
      {
        tunnels: [
          {
            public_url: "https://stale.ngrok-free.app",
            config: { addr: "localhost:7830" },
          },
        ],
      },
      {
        tunnels: [
          {
            public_url: "https://second.ngrok-free.app",
            config: { addr: "localhost:18080" },
          },
        ],
      },
    ]);

    const run = realNgrok.runNgrokTunnel({ port: 18080 });
    // runNgrokTunnel blocks until the ngrok process exits; pump exit events
    // until its final exit listener is registered and the promise settles.
    const pump = setInterval(() => lastChild?.emit("exit", 0), 10);
    try {
      await run;
    } finally {
      clearInterval(pump);
    }

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, args] = spawnMock.mock.calls[0];
    // Layered config: the user's default (authtoken) under ours (web_addr).
    expect(args).toEqual([
      "http",
      "127.0.0.1:18080",
      "--log=stdout",
      `--config=${defaultNgrokConfigPath}`,
      `--config=${realNgrok.ngrokAgentConfigPath()}`,
    ]);

    expect(readTunnelRecord()).toMatchObject({
      provider: "ngrok",
      publicUrl: "https://second.ngrok-free.app",
    });
  });

  test("runNgrokTunnel without --domain reuses the saved domain and does not delete it", async () => {
    makeWorkspace({});
    realNgrok.saveNgrokDomain("foo.ngrok.app");
    mockNgrokApiFetch([
      null,
      {
        tunnels: [
          {
            public_url: "https://foo.ngrok.app",
            config: { addr: "localhost:7831" },
          },
        ],
      },
    ]);

    const run = realNgrok.runNgrokTunnel({ port: 7831 });
    const pump = setInterval(() => lastChild?.emit("exit", 0), 10);
    try {
      await run;
    } finally {
      clearInterval(pump);
    }

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, args] = spawnMock.mock.calls[0];
    expect(args).toEqual([
      "http",
      "127.0.0.1:7831",
      "--log=stdout",
      "--domain=foo.ngrok.app",
    ]);

    expect(readTunnelRecord()).toMatchObject({
      provider: "ngrok",
      publicUrl: "https://foo.ngrok.app",
    });
    expect(realNgrok.loadNgrokDomain()).toBe("foo.ngrok.app");
  });
});

describe("tunnel start runs the providers directly", () => {
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

  const spawnMock = mock(
    (
      _command: string,
      _args: readonly string[],
      _options?: SpawnOptions,
    ): ChildProcess => {
      const child = new realChildProcess.ChildProcess();
      // kill() stays stubbed: the fake pid must never be signaled for real.
      // stdout/stderr: the real class resolves them through a getter over the
      // internal spawn handle, so null-shadow them via defineProperty — an
      // Object.assign [[Set]] through the getter-only accessor throws.
      Object.defineProperty(child, "stdout", { value: null });
      Object.defineProperty(child, "stderr", { value: null });
      return Object.assign(child, { pid: 9999, kill: () => true });
    },
  );

  beforeAll(() => {
    // The edge-targeting describe's afterAll restores the REAL provider
    // modules; re-establish the fakes these tests need.
    mock.module("../lib/tunnels/ngrok", () => ({
      ...realNgrok,
      runNgrokTunnel: runNgrokTunnelMock,
      NGROK_PROVIDER: { ...realNgrok.NGROK_PROVIDER, run: runNgrokTunnelMock },
    }));
    mock.module("../lib/servers/nginx.js", () => ({
      ...realNginxIngress,
      ensureAppServer: ensureAppServerMock,
      getNginxVersion: getNginxVersionMock,
    }));
    mock.module("@mycadet/local-mode", () => ({
      ...localModeModule,
      isIngressRunning: isIngressRunningMock,
      readIngressState: readIngressStateMock,
    }));
    mock.module("node:child_process", () => ({
      ...realChildProcess,
      spawn: spawnMock,
    }));
  });

  afterAll(() => {
    mock.module("node:child_process", () => realChildProcess);
    mock.module("../lib/tunnels/ngrok", () => realNgrok);
    mock.module("../lib/servers/nginx.js", () => realNginxIngress);
    mock.module("@mycadet/local-mode", () => localModeModule);
  });

  beforeEach(() => {
    spawnMock.mockClear();
    runNgrokTunnelMock.mockReset();
    runNgrokTunnelMock.mockResolvedValue(
      fakeTunnelResult("https://test.example.ngrok.dev"),
    );
    ensureAppServerMock.mockReset();
    ensureAppServerMock.mockResolvedValue({
      port: EDGE_PORT,
      started: true,
    });
    const configHome = mkdtempSync(join(tmpdir(), "cadet-tunnel-xdg-"));
    tempDirs.push(configHome);
    process.env.XDG_CONFIG_HOME = configHome;
    writeLockfile(makeLocalEntry());
  });

  afterEach(() => {
    if (originalXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("starts the tunnel in this process — no self-relaunch — and returns while the agent lives", async () => {
    process.argv = ["bun", "cadet", "tunnel", "start", "--provider", "ngrok"];
    // The provider narrates its own establishment (the command adds nothing
    // around it).
    runNgrokTunnelMock.mockImplementation(async () => {
      console.log("Tunnel established: https://test.example.ngrok.dev");
      return fakeTunnelResult("https://test.example.ngrok.dev");
    });

    const logs = await runTunnelCapturingLogs();

    // The command never re-invokes itself: it calls the provider directly
    // (which spawns the detached agent) and returns as soon as the tunnel
    // establishes — the agent outlives the process.
    expect(spawnMock).not.toHaveBeenCalled();
    expect(ensureAppServerMock).toHaveBeenCalledTimes(1);
    expect(runNgrokTunnelMock).toHaveBeenCalledTimes(1);
    expect(logs).toContain(
      "Tunnel established: https://test.example.ngrok.dev",
    );
  });

  test("a provider failure surfaces loudly instead of being swallowed", async () => {
    process.argv = ["bun", "cadet", "tunnel", "start", "--provider", "ngrok"];
    runNgrokTunnelMock.mockRejectedValue(new Error("ngrok is not installed."));

    await expect(runTunnelCapturingLogs()).rejects.toThrow(
      "ngrok is not installed.",
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe("restoreAppServerAndAutoTunnel — ensure the recorded tunnel", () => {
  const TAILNET_URL = "https://test-machine.tailnet.ts.net";
  let restoreFlow: typeof import("../lib/tunnel.js");
  let logSpy: ReturnType<typeof spyOn>;
  let warnSpy: ReturnType<typeof spyOn>;

  beforeAll(async () => {
    // The edge-targeting describe's afterAll restores the REAL provider
    // modules; re-establish the fakes the restore flow's tests need.
    mock.module("../lib/tunnels/tailscale.js", () => ({
      ...realTailscaleTunnel,
      TAILSCALE_PROVIDER: {
        ...realTailscaleTunnel.TAILSCALE_PROVIDER,
        run: runTailscaleTunnelMock,
      },
    }));
    mock.module("../lib/servers/nginx.js", () => ({
      ...realNginxIngress,
      ensureAppServer: ensureAppServerMock,
      getNginxVersion: getNginxVersionMock,
      isIngressRunning: isIngressRunningMock,
      readIngressState: readIngressStateMock,
    }));
    restoreFlow = await import("../lib/tunnel.js");
  });

  beforeEach(() => {
    ensureAppServerMock.mockReset();
    ensureAppServerMock.mockImplementation(async () => ({
      port: EDGE_PORT,
      started: true,
    }));
    runTailscaleTunnelMock.mockReset();
    runTailscaleTunnelMock.mockImplementation(async () => {
      // The real run stamps the lockfile record with the URL it published —
      // the wake restore's gate and the edge refresh both read it.
      stampRootProcess("tunnel", {
        pid: process.pid,
        provider: "tailscale",
        startedAt: new Date().toISOString(),
        publicUrl: TAILNET_URL,
      });
      return { publicUrl: TAILNET_URL };
    });
    isIngressRunningMock.mockReset();
    isIngressRunningMock.mockImplementation(() => false);
    readIngressStateMock.mockReset();
    readIngressStateMock.mockImplementation(() => null);
    notifyGatewayOfPublicUrlMock.mockReset();
    notifyGatewayOfPublicUrlMock.mockImplementation(async () => {});
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    process.argv = originalArgv;
    globalThis.fetch = originalFetch;
    rmSync(realNgrok.ngrokConfigPath(), { force: true });
    if (originalConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalConfigHome;
    }
    if (originalWorkspaceDir === undefined) {
      delete process.env.CADET_WORKSPACE_DIR;
    } else {
      process.env.CADET_WORKSPACE_DIR = originalWorkspaceDir;
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The suite re-mocked the provider + edge modules in beforeAll; restore
  // the real ones or the mocks leak into whichever file Bun runs next.
  afterAll(() => {
    mock.module("../lib/tunnels/tailscale.js", () => realTailscaleTunnel);
    mock.module("../lib/servers/nginx.js", () => realNginxIngress);
    mock.module("@mycadet/local-mode", () => localModeModule);
  });

  function seedRecordedTailnetWake(): {
    entry: LocalAssistant;
    workspaceDir: string;
  } {
    const entry = makeLocalEntry();
    writeLockfile(entry);
    stampRootProcess("tunnel", {
      pid: 4321,
      provider: "tailscale",
      startedAt: new Date().toISOString(),
      publicUrl: TAILNET_URL,
    });
    stampRootProcess("app", {
      pid: 4321,
      port: EDGE_PORT,
      startedAt: new Date().toISOString(),
    });
    const workspaceDir = writeDefaultWorkspaceConfig({});
    return { entry, workspaceDir };
  }

  test("a recorded tailnet tunnel re-establishes the serve at the app server's port and re-records the url", async () => {
    seedRecordedTailnetWake();

    await restoreFlow.restoreAppServerAndAutoTunnel();

    // Step 1: the edge started even though the gateway had cleared the url —
    // the lockfile's records are why the wake still wants both back.
    expect(ensureAppServerMock).toHaveBeenCalledWith();
    // Step 2: the tunnel re-established at the app server's port, never the
    // gateway's fallback port.
    expect(runTailscaleTunnelMock).toHaveBeenCalledWith({ port: EDGE_PORT });
    // Step 3: the url rode to every locally-reachable assistant's gateway,
    // and the lockfile record carries it again.
    expect(notifyGatewayOfPublicUrlMock).toHaveBeenCalledWith(
      TAILNET_URL,
      "assistant-1",
    );
    expect(readRootProcesses().tunnel?.publicUrl).toBe(TAILNET_URL);
  });

  test("the fresh url re-ensures the edge so the served config carries it the same wake", async () => {
    seedRecordedTailnetWake();
    isIngressRunningMock.mockImplementation(() => true);
    readIngressStateMock.mockImplementation(() => ({
      listenPort: EDGE_PORT,
      gatewayUrl: "http://127.0.0.1:7830",
    }));

    await restoreFlow.restoreAppServerAndAutoTunnel();

    expect(ensureAppServerMock).toHaveBeenCalledTimes(2);
  });

  test("a stopped tunnel cleared its root record, so the wake resurrects no tunnel", async () => {
    const entry = makeLocalEntry();
    writeLockfile(entry);
    // The app entry survives, so the edge comes back — but the cleared
    // tunnel record leaves the dispatch nothing to ensure.
    stampRootProcess("app", {
      pid: 4321,
      port: EDGE_PORT,
      startedAt: new Date().toISOString(),
    });
    const workspaceDir = join(getLocalInstanceDir(entry), "workspace");
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(
      join(workspaceDir, "config.json"),
      JSON.stringify(
        {
          ingress: {
            enabled: true,
            lastTunnel: { provider: "tailscale", publicBaseUrl: TAILNET_URL },
          },
        },
        null,
        2,
      ),
    );

    await restoreFlow.restoreAppServerAndAutoTunnel();

    expect(ensureAppServerMock).toHaveBeenCalled();
    expect(runTailscaleTunnelMock).not.toHaveBeenCalled();
    expect(notifyGatewayOfPublicUrlMock).not.toHaveBeenCalled();
  });

  test("a workspace with no recorded app server wants no edge", async () => {
    const entry = makeLocalEntry();
    writeLockfile(entry);
    writeDefaultWorkspaceConfig({
      ingress: { enabled: true },
    });

    await restoreFlow.restoreAppServerAndAutoTunnel();

    expect(ensureAppServerMock).not.toHaveBeenCalled();
    expect(runTailscaleTunnelMock).not.toHaveBeenCalled();
    expect(notifyGatewayOfPublicUrlMock).not.toHaveBeenCalled();
  });

  test("a cloudflare run failure is non-fatal for the restore", async () => {
    const entry = makeLocalEntry();
    writeLockfile(entry);
    stampRootProcess("tunnel", {
      pid: 4321,
      provider: "cloudflare",
      startedAt: new Date().toISOString(),
      publicUrl: "https://x.trycloudflare.com",
    });
    stampRootProcess("app", {
      pid: 4321,
      port: EDGE_PORT,
      startedAt: new Date().toISOString(),
    });
    writeDefaultWorkspaceConfig({
      ingress: { enabled: true },
    });

    await restoreFlow.restoreAppServerAndAutoTunnel();

    expect(ensureAppServerMock).toHaveBeenCalled();
    expect(runTailscaleTunnelMock).not.toHaveBeenCalled();
    expect(notifyGatewayOfPublicUrlMock).not.toHaveBeenCalled();
  });

  test("a pairing-only tailnet run published no ingress base URL, so the restore re-establishes nothing", async () => {
    const entry = makeLocalEntry();
    writeLockfile(entry);
    stampRootProcess("tunnel", {
      pid: 4321,
      provider: "tailscale",
      startedAt: new Date().toISOString(),
    });
    stampRootProcess("app", {
      pid: 4321,
      port: EDGE_PORT,
      startedAt: new Date().toISOString(),
    });
    // The saved webhook callback base stands (a pairing run leaves it); the
    // record's missing `publicUrl` is what keeps the restore from repointing
    // it at the tailnet address.
    writeDefaultWorkspaceConfig({
      ingress: {
        enabled: true,
        publicBaseUrl: "https://x.ngrok.app",
      },
    });

    await restoreFlow.restoreAppServerAndAutoTunnel();

    // The pairing run did not repoint the webhook callback base; the restore
    // must not repoint it either.
    expect(runTailscaleTunnelMock).not.toHaveBeenCalled();
    expect(notifyGatewayOfPublicUrlMock).not.toHaveBeenCalled();
  });

  test("the record alone drives the restore — no workspace record is consulted", async () => {
    const entry = makeLocalEntry();
    writeLockfile(entry);
    stampRootProcess("tunnel", {
      pid: 4321,
      provider: "tailscale",
      startedAt: new Date().toISOString(),
      publicUrl: TAILNET_URL,
    });
    stampRootProcess("app", {
      pid: 4321,
      port: EDGE_PORT,
      startedAt: new Date().toISOString(),
    });
    // An empty workspace config: nothing in it names a tunnel or a URL.
    writeDefaultWorkspaceConfig({});

    await restoreFlow.restoreAppServerAndAutoTunnel();

    // The lockfile's tunnel record published a URL, so the recorded tailnet
    // tunnel is re-established and the URL is saved again.
    expect(runTailscaleTunnelMock).toHaveBeenCalledWith({ port: EDGE_PORT });
    expect(notifyGatewayOfPublicUrlMock).toHaveBeenCalledWith(
      TAILNET_URL,
      entry.assistantId,
    );
  });
});
