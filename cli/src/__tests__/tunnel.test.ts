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
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TUNNEL_PROVIDERS } from "@mycadet/service-contracts/ingress";
import { parse } from "yaml";
import { z } from "zod";

import * as cloudflareTunnel from "../lib/tunnels/cloudflare.js";
import * as gatewayNotify from "../lib/tunnels/gateway-notify.js";
import * as ngrok from "../lib/tunnels/ngrok.js";
import * as nginxIngress from "../lib/nginx-ingress.js";
import * as tailscaleTunnel from "../lib/tunnels/tailscale.js";
import { getLogDir } from "../lib/xdg-log.js";
import { saveIngressUrl } from "../lib/ingress-config.js";
import { stampRootProcess } from "../lib/assistant-config.js";
import {
  getLocalInstanceDir,
  type LockfileAssistant,
} from "../lib/assistant-config.js";
import { withPreconnect } from "./helpers/http.js";

const realCloudflareTunnel = { ...cloudflareTunnel };
const realGatewayNotify = { ...gatewayNotify };
const realNgrok = { ...ngrok };
const realNginxIngress = { ...nginxIngress };
const realTailscaleTunnel = { ...tailscaleTunnel };
const realChildProcess = { ...childProcess };

/** What a mocked provider run hands back: a URL and an already-settled exit. */
const fakeTunnelResult = (publicUrl: string) => ({
  publicUrl,
  waitForExit: Promise.resolve(),
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
const startTailnetServeMock = mock<
  (opts: {
    port: number;
    workspaceDir: string;
    assistantId?: string;
  }) => Promise<string | null>
>(async () => null);
mock.module("../lib/tunnels/tailscale.js", () => ({
  ...realTailscaleTunnel,
  runTailscaleTunnel: runTailscaleTunnelMock,
  TAILSCALE_PROVIDER: {
    ...realTailscaleTunnel.TAILSCALE_PROVIDER,
    run: runTailscaleTunnelMock,
    start: startTailnetServeMock,
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
const isIngressRunningMock = mock<typeof nginxIngress.isIngressRunning>(
  () => false,
);
const readIngressStateMock = mock<typeof nginxIngress.readIngressState>(
  () => null,
);
const getNginxVersionMock = mock<typeof nginxIngress.getNginxVersion>(
  () => "nginx version (test)",
);
mock.module("../lib/nginx-ingress.js", () => ({
  ...realNginxIngress,
  ensureAppServer: ensureAppServerMock,
  getNginxVersion: getNginxVersionMock,
}));

const { tunnel } = await import("../commands/tunnel.js");

const originalArgv = [...process.argv];
const originalFetch = globalThis.fetch;
const originalConfigHome = process.env.XDG_CONFIG_HOME;
const originalWorkspaceDir = process.env.CADET_WORKSPACE_DIR;
const tempDirs: string[] = [];

function makeLocalEntry(assistantId = "assistant-1"): LockfileAssistant {
  const instanceDir = mkdtempSync(join(tmpdir(), "cadet-tunnel-test-"));
  tempDirs.push(instanceDir);
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

function makeCloudEntry(assistantId = "cloud-1"): LockfileAssistant {
  return {
    assistantId,
    runtimeUrl: `https://runtime.example.com/${assistantId}`,
    cloud: "cloud",
  };
}

/** A `hatch --remote docker` entry: local container gateway, no `resources`. */
function makeDockerEntry(assistantId = "docker-1"): LockfileAssistant {
  return {
    assistantId,
    runtimeUrl: "http://localhost:7930",
    cloud: "docker",
  };
}

/** A macOS-app-managed entry: local container gateway, no `resources`. */
function makeAppleContainerEntry(assistantId = "apple-1"): LockfileAssistant {
  return {
    assistantId,
    runtimeUrl: "http://localhost:8030",
    cloud: "apple-container",
  };
}

/** Seed a local entry's workspace config; returns that workspace dir. */
function writeEntryWorkspaceConfig(
  entry: LockfileAssistant,
  config: Record<string, unknown>,
): string {
  const workspaceDir = join(getLocalInstanceDir(entry.resources), "workspace");
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

const IngressTestConfigSchema = z.object({
  ingress: z
    .looseObject({
      publicBaseUrl: z.string().optional(),
      ngrok: z.object({ domain: z.string().optional() }).optional(),
    })
    .optional(),
});

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
      "--foreground",
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
    mock.module("../lib/nginx-ingress.js", () => realNginxIngress);
  });

  test("targets the edge port returned by ensureAppServer for ngrok", async () => {
    const entry = makeLocalEntry();
    entry.runtimeUrl = "https://stale-tunnel.ngrok-free.dev";
    writeLockfile(entry);
    process.argv = [
      "bun",
      "cadet",
      "tunnel",
      "start",
      "--provider",
      "ngrok",
      "--foreground",
    ];

    const logs = await runTunnelCapturingLogs();

    const workspaceDir = join(
      getLocalInstanceDir(entry.resources),
      "workspace",
    );
    expect(ensureAppServerMock).toHaveBeenCalledWith({
      assistantId: "assistant-1",
      workspaceDir,
      gatewayPort: 7830,
    });
    expect(runNgrokTunnelMock).toHaveBeenCalledWith({
      port: EDGE_PORT,
      assistantId: "assistant-1",
      workspaceDir,
    });
    expect(runCloudflareTunnelMock).not.toHaveBeenCalled();
    expect(logs).toContain(`Started the nginx edge on 127.0.0.1:${EDGE_PORT}`);
  });

  test("the tunnel level notifies every local gateway of the public URL", async () => {
    const second = makeLocalEntry("assistant-2");
    writeLockfile([makeLocalEntry(), second]);
    process.argv = [
      "bun",
      "cadet",
      "tunnel",
      "start",
      "--provider",
      "ngrok",
      "--foreground",
    ];

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

  test("an active cloud assistant falls back to the sole local entry with a note", async () => {
    const cloud = makeCloudEntry();
    const local = makeLocalEntry();
    writeLockfile([cloud, local], cloud.assistantId);
    process.argv = [
      "bun",
      "cadet",
      "tunnel",
      "start",
      "--provider",
      "ngrok",
      "--foreground",
    ];

    const logs = await runTunnelCapturingLogs();

    const workspaceDir = join(
      getLocalInstanceDir(local.resources),
      "workspace",
    );
    expect(logs).toContain(
      "Assistant 'cloud-1' runs on Cadet Cloud and needs no tunnel. " +
        "Tunneling the local assistant 'assistant-1' instead.",
    );
    expect(ensureAppServerMock).toHaveBeenCalledWith({
      assistantId: "assistant-1",
      workspaceDir,
      gatewayPort: 7830,
    });
    expect(runNgrokTunnelMock).toHaveBeenCalledWith({
      port: EDGE_PORT,
      assistantId: "assistant-1",
      workspaceDir,
    });
  });

  test("a docker assistant set active tunnels via its runtimeUrl gateway port", async () => {
    const workspaceDir = useTempDefaultWorkspaceDir();
    const local = makeLocalEntry();
    writeLockfile([local, makeDockerEntry()], "docker-1");
    process.argv = [
      "bun",
      "cadet",
      "tunnel",
      "start",
      "--provider",
      "ngrok",
      "--foreground",
    ];

    await runTunnelCapturingLogs();

    expect(ensureAppServerMock).toHaveBeenCalledWith({
      assistantId: "docker-1",
      workspaceDir,
      gatewayPort: 7930,
    });
    expect(runNgrokTunnelMock).toHaveBeenCalledWith({
      port: EDGE_PORT,
      assistantId: "docker-1",
      workspaceDir,
    });
  });

  test("an active docker assistant tunnels on a bare invocation", async () => {
    const workspaceDir = useTempDefaultWorkspaceDir();
    const docker = makeDockerEntry();
    writeLockfile(docker, docker.assistantId);
    process.argv = [
      "bun",
      "cadet",
      "tunnel",
      "start",
      "--provider",
      "ngrok",
      "--foreground",
    ];

    await runTunnelCapturingLogs();

    expect(ensureAppServerMock).toHaveBeenCalledWith({
      assistantId: "docker-1",
      workspaceDir,
      gatewayPort: 7930,
    });
    expect(runNgrokTunnelMock).toHaveBeenCalledWith({
      port: EDGE_PORT,
      assistantId: "docker-1",
      workspaceDir,
    });
  });

  test("an active cloud assistant falls back to a sole docker entry with a note", async () => {
    const workspaceDir = useTempDefaultWorkspaceDir();
    const cloud = makeCloudEntry();
    writeLockfile([cloud, makeDockerEntry()], cloud.assistantId);
    process.argv = [
      "bun",
      "cadet",
      "tunnel",
      "start",
      "--provider",
      "ngrok",
      "--foreground",
    ];

    const logs = await runTunnelCapturingLogs();

    expect(logs).toContain(
      "Assistant 'cloud-1' runs on Cadet Cloud and needs no tunnel. " +
        "Tunneling the local assistant 'docker-1' instead.",
    );
    expect(runNgrokTunnelMock).toHaveBeenCalledWith({
      port: EDGE_PORT,
      assistantId: "docker-1",
      workspaceDir,
    });
  });

  test("an active cloud assistant with no local entries exits with an error", async () => {
    writeLockfile(makeCloudEntry());
    process.argv = [
      "bun",
      "cadet",
      "tunnel",
      "start",
      "--provider",
      "ngrok",
      "--foreground",
    ];

    const { exited, errors } = await runTunnelExpectingExit1();

    expect(exited).toBe(true);
    expect(errors).toContain(
      "Assistant 'cloud-1' runs on Cadet Cloud and needs no tunnel.",
    );
    expect(errors).toContain("No local assistant found to tunnel");
    expect(ensureAppServerMock).not.toHaveBeenCalled();
    expect(runNgrokTunnelMock).not.toHaveBeenCalled();
  });

  test("an active cloud assistant with multiple local entries exits listing them", async () => {
    const cloud = makeCloudEntry();
    writeLockfile(
      [cloud, makeLocalEntry("assistant-a"), makeLocalEntry("assistant-b")],
      cloud.assistantId,
    );
    process.argv = [
      "bun",
      "cadet",
      "tunnel",
      "start",
      "--provider",
      "ngrok",
      "--foreground",
    ];

    const { exited, errors } = await runTunnelExpectingExit1();

    expect(exited).toBe(true);
    expect(errors).toContain(
      "Assistant 'cloud-1' runs on Cadet Cloud and needs no tunnel.",
    );
    expect(errors).toContain(
      "Multiple local assistants found; set the one to front with `cadet use <name>`.",
    );
    expect(ensureAppServerMock).not.toHaveBeenCalled();
    expect(runNgrokTunnelMock).not.toHaveBeenCalled();
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
      "--foreground",
    ];

    const { exited, errors } = await runTunnelExpectingExit1();

    expect(exited).toBe(true);
    expect(errors).toContain("takes no assistant name");
    expect(ensureAppServerMock).not.toHaveBeenCalled();
    expect(runNgrokTunnelMock).not.toHaveBeenCalled();
  });

  test("an apple-container assistant set active tunnels via its runtimeUrl gateway port", async () => {
    const workspaceDir = useTempDefaultWorkspaceDir();
    const local = makeLocalEntry();
    writeLockfile([local, makeAppleContainerEntry()], "apple-1");
    process.argv = [
      "bun",
      "cadet",
      "tunnel",
      "start",
      "--provider",
      "ngrok",
      "--foreground",
    ];

    await runTunnelCapturingLogs();

    expect(ensureAppServerMock).toHaveBeenCalledWith({
      assistantId: "apple-1",
      workspaceDir,
      gatewayPort: 8030,
    });
    expect(runNgrokTunnelMock).toHaveBeenCalledWith({
      port: EDGE_PORT,
      assistantId: "apple-1",
      workspaceDir,
    });
  });

  test("an active cloud assistant falls back to a sole apple-container entry with a note", async () => {
    const workspaceDir = useTempDefaultWorkspaceDir();
    const cloud = makeCloudEntry();
    writeLockfile([cloud, makeAppleContainerEntry()], cloud.assistantId);
    process.argv = [
      "bun",
      "cadet",
      "tunnel",
      "start",
      "--provider",
      "ngrok",
      "--foreground",
    ];

    const logs = await runTunnelCapturingLogs();

    expect(logs).toContain(
      "Assistant 'cloud-1' runs on Cadet Cloud and needs no tunnel. " +
        "Tunneling the local assistant 'apple-1' instead.",
    );
    expect(ensureAppServerMock).toHaveBeenCalledWith({
      assistantId: "apple-1",
      workspaceDir,
      gatewayPort: 8030,
    });
    expect(runNgrokTunnelMock).toHaveBeenCalledWith({
      port: EDGE_PORT,
      assistantId: "apple-1",
      workspaceDir,
    });
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
      "--foreground",
    ];

    await runTunnelCapturingLogs();

    expect(runCloudflareTunnelMock).toHaveBeenCalledWith({
      port: EDGE_PORT,
      assistantId: "assistant-1",
      workspaceDir: join(getLocalInstanceDir(entry.resources), "workspace"),
    });
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
      "--foreground",
    ];
    ensureAppServerMock.mockResolvedValue({
      port: EDGE_PORT,
      started: false,
    });

    const logs = await runTunnelCapturingLogs();

    expect(runTailscaleTunnelMock).toHaveBeenCalledWith({
      port: EDGE_PORT,
      assistantId: "assistant-1",
      workspaceDir: join(getLocalInstanceDir(entry.resources), "workspace"),
    });
    expect(logs).toContain(`Reusing the nginx edge on 127.0.0.1:${EDGE_PORT}`);
  });

  test("a bare invocation tunnels the default provider", async () => {
    const entry = makeLocalEntry();
    writeLockfile(entry);
    process.argv = ["bun", "cadet", "tunnel", "start", "--foreground"];

    const logs = await runTunnelCapturingLogs();

    expect(logs).toContain("Using the default provider: ngrok");
    expect(runNgrokTunnelMock).toHaveBeenCalledWith({
      port: EDGE_PORT,
      assistantId: "assistant-1",
      workspaceDir: join(getLocalInstanceDir(entry.resources), "workspace"),
    });
    expect(ensureAppServerMock).toHaveBeenCalled();
    expect(runTailscaleTunnelMock).not.toHaveBeenCalled();
    expect(runCloudflareTunnelMock).not.toHaveBeenCalled();
  });

  test("--provider tailscale keeps the webhook callback base and says so", async () => {
    const entry = makeLocalEntry();
    writeLockfile(entry);
    const workspaceDir = writeEntryWorkspaceConfig(entry, {
      telegram: { botUsername: "example_bot" },
    });
    process.argv = [
      "bun",
      "cadet",
      "tunnel",
      "start",
      "--provider",
      "tailscale",
      "--foreground",
    ];

    const warnings: string[] = [];
    const warnSpy = spyOn(console, "warn").mockImplementation(
      (...a: unknown[]) => {
        warnings.push(a.join(" "));
      },
    );
    try {
      await runTunnelCapturingLogs();
    } finally {
      warnSpy.mockRestore();
    }

    const warned = warnings.join("\n");
    expect(warned).toContain("reachable only from your own tailnet");
    expect(warned).toContain("saved ingress base URL stays as it is");
    // The tunnel publishes a pairing address instead of replacing the URL the
    // webhook callbacks resolve through.
    expect(runTailscaleTunnelMock).toHaveBeenCalledWith({
      port: EDGE_PORT,
      assistantId: "assistant-1",
      workspaceDir,
      preserveIngressUrl: true,
    });
  });

  test("tailscale without webhook integrations still owns the ingress URL", async () => {
    const entry = makeLocalEntry();
    writeLockfile(entry);
    const workspaceDir = writeEntryWorkspaceConfig(entry, {});
    process.argv = [
      "bun",
      "cadet",
      "tunnel",
      "start",
      "--provider",
      "tailscale",
      "--foreground",
    ];

    await runTunnelCapturingLogs();

    expect(runTailscaleTunnelMock).toHaveBeenCalledWith({
      port: EDGE_PORT,
      assistantId: "assistant-1",
      workspaceDir,
    });
  });

  test("a public provider is unaffected by configured webhook integrations", async () => {
    const entry = makeLocalEntry();
    writeLockfile(entry);
    const workspaceDir = writeEntryWorkspaceConfig(entry, {
      telegram: { botUsername: "example_bot" },
    });
    process.argv = [
      "bun",
      "cadet",
      "tunnel",
      "start",
      "--provider",
      "ngrok",
      "--foreground",
    ];

    await runTunnelCapturingLogs();

    expect(runNgrokTunnelMock).toHaveBeenCalledWith({
      port: EDGE_PORT,
      assistantId: "assistant-1",
      workspaceDir,
    });
  });

  test("missing nginx aborts before any provider spawn", async () => {
    process.argv = [
      "bun",
      "cadet",
      "tunnel",
      "start",
      "--provider",
      "ngrok",
      "--foreground",
    ];
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
    process.argv = [
      "bun",
      "cadet",
      "tunnel",
      "start",
      "--provider",
      "bogus",
      "--foreground",
    ];

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
          "--foreground",
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
      "--foreground",
    ];

    await runTunnelCapturingLogs();

    expect(runNgrokTunnelMock).toHaveBeenCalledWith({
      port: EDGE_PORT,
      assistantId: "assistant-1",
      workspaceDir: join(getLocalInstanceDir(entry.resources), "workspace"),
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
      "--foreground",
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
    const workspaceDir = join(
      getLocalInstanceDir(entry.resources),
      "workspace",
    );
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
      "--foreground",
    ];

    const logs = await runTunnelCapturingLogs();

    expect(logs).toContain("Cleared the saved reserved domain");
    // The saved domain lives in the XDG ngrok config, not the workspace config.
    expect(realNgrok.loadNgrokDomain()).toBeNull();
    // The run proceeds domainless: no `domain` key reaches runNgrokTunnel.
    expect(runNgrokTunnelMock).toHaveBeenCalledWith({
      port: EDGE_PORT,
      assistantId: "assistant-1",
      workspaceDir,
    });
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
      "--foreground",
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
      "--foreground",
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
      "--foreground",
    ];

    const { exited, errors } = await runTunnelExpectingExit1();

    expect(exited).toBe(true);
    expect(errors).toContain("--domain requires a value");
    expect(runNgrokTunnelMock).not.toHaveBeenCalled();
  });

  test("a not-yet-implemented provider error carries the stale-CLI hint", async () => {
    // `cadet` stays valid-but-unimplemented, so it hits this path rather
    // than the unknown-provider one.
    process.argv = [
      "bun",
      "cadet",
      "tunnel",
      "start",
      "--provider",
      "cadet",
      "--foreground",
    ];

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

  function readIngress(ws: string): Record<string, unknown> {
    const config = IngressTestConfigSchema.parse(
      JSON.parse(readFileSync(join(ws, "config.json"), "utf-8")),
    );
    return config.ingress ?? {};
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
    const ws = makeWorkspace({});
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
      workspaceDir: ws,
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

    const config = IngressTestConfigSchema.parse(
      JSON.parse(readFileSync(join(ws, "config.json"), "utf-8")),
    );
    expect(config.ingress?.publicBaseUrl).toBe("https://foo.ngrok.app");
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
    const ws = makeWorkspace({});
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
          workspaceDir: ws,
          domain: "foo.ngrok.app",
        }),
      ).rejects.toThrow("exit:1");
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

    const config = IngressTestConfigSchema.parse(
      JSON.parse(readFileSync(join(ws, "config.json"), "utf-8")),
    );
    expect(config.ingress?.publicBaseUrl).toBeUndefined();
    expect(config.ingress?.ngrok).toBeUndefined();
  });

  test("runNgrokTunnel adopts an existing tunnel that matches the requested domain", async () => {
    const ws = makeWorkspace({});
    mockTunnelListFetch("https://foo.ngrok.app", "localhost:7831");

    const run = realNgrok.runNgrokTunnel({
      port: 7831,
      workspaceDir: ws,
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
    const config = IngressTestConfigSchema.parse(
      JSON.parse(readFileSync(join(ws, "config.json"), "utf-8")),
    );
    expect(config.ingress?.publicBaseUrl).toBe("https://foo.ngrok.app");
    expect(realNgrok.loadNgrokDomain()).toBe("foo.ngrok.app");
  });

  test("maybeStartNgrokTunnel rejects a mismatched existing tunnel without adopting or spawning", async () => {
    const ws = makeWorkspace({ telegram: { botUsername: "example_bot" } });
    realNgrok.saveNgrokDomain("foo.ngrok.app");
    mockTunnelListFetch("https://other.ngrok-free.app", "localhost:7830");

    const warnings: string[] = [];
    const warnSpy = spyOn(console, "warn").mockImplementation(
      (...a: unknown[]) => {
        warnings.push(a.join(" "));
      },
    );

    let child: unknown;
    try {
      child = await realNgrok.maybeStartNgrokTunnel(7830, ws);
    } finally {
      warnSpy.mockRestore();
    }

    expect(child).toBeNull();
    expect(spawnMock).not.toHaveBeenCalled();
    const combined = warnings.join("\n");
    expect(combined).toContain("https://other.ngrok-free.app");
    expect(combined).toContain(
      "does not match the reserved domain 'foo.ngrok.app'",
    );
    expect(combined).toContain(
      "cadet tunnel start --provider ngrok --domain foo.ngrok.app",
    );

    const config = IngressTestConfigSchema.parse(
      JSON.parse(readFileSync(join(ws, "config.json"), "utf-8")),
    );
    // The mismatched tunnel is not blessed in config…
    expect(config.ingress?.publicBaseUrl).toBeUndefined();
    // …and the reserved domain stays saved as standing intent.
    expect(realNgrok.loadNgrokDomain()).toBe("foo.ngrok.app");
  });

  test("an adopted automatic tunnel records the assistant it fronts", async () => {
    const ws = makeWorkspace({ telegram: { botUsername: "example_bot" } });
    mockTunnelListFetch("https://adopted.ngrok.app", "localhost:7830");

    const child = await withLockfileFor("adopt-assistant", () =>
      realNgrok.maybeStartNgrokTunnel(7830, ws, "adopt-assistant"),
    );

    expect(child).toBeNull();
    expect(readIngress(ws)).toMatchObject({
      publicBaseUrl: "https://adopted.ngrok.app",
      assistantId: "adopt-assistant",
      lastTunnel: {
        provider: "ngrok",
        publicBaseUrl: "https://adopted.ngrok.app",
      },
    });
  });

  test("a spawned automatic tunnel records the assistant it fronts", async () => {
    const ws = makeWorkspace({ telegram: { botUsername: "example_bot" } });
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

    const child = await withLockfileFor("spawn-assistant", () =>
      realNgrok.maybeStartNgrokTunnel(7830, ws, "spawn-assistant"),
    );

    expect(child).not.toBeNull();
    expect(readIngress(ws)).toMatchObject({
      publicBaseUrl: "https://spawned.ngrok.app",
      assistantId: "spawn-assistant",
      lastTunnel: {
        provider: "ngrok",
        publicBaseUrl: "https://spawned.ngrok.app",
      },
    });
  });

  test("maybeStartNgrokTunnel starts a second agent when the first tunnels a different port", async () => {
    const ws = makeWorkspace({ telegram: { botUsername: "example_bot" } });
    // Discovery sees the first agent on the default inspection port, serving
    // some other tunnel; after the second agent spawns, its own API reports
    // the new tunnel for the requested port.
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

    const child = await withLockfileFor("second-agent", () =>
      realNgrok.maybeStartNgrokTunnel(18080, ws, "second-agent"),
    );

    // Concurrent agents are supported: the second agent spawned instead of
    // the old skip-and-warn.
    expect(child).not.toBeNull();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, args] = spawnMock.mock.calls[0];
    expect(args).toEqual([
      "http",
      "127.0.0.1:18080",
      "--log=stdout",
      `--config=${defaultNgrokConfigPath}`,
      `--config=${realNgrok.ngrokAgentConfigPath()}`,
    ]);
    expect(readIngress(ws)).toMatchObject({
      publicBaseUrl: "https://second.ngrok-free.app",
      assistantId: "second-agent",
    });
    // The second agent's inspection address is recorded so the next run can
    // rediscover it for adoption.
    const agentConfig = parse(
      readFileSync(realNgrok.ngrokAgentConfigPath(), "utf-8"),
    );
    expect(agentConfig.web_addr).toBe("127.0.0.1:4041");
  });

  test("runNgrokTunnel starts a second agent when the first tunnels a different port", async () => {
    const ws = makeWorkspace({});
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

    const run = realNgrok.runNgrokTunnel({ port: 18080, workspaceDir: ws });
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

    const config = IngressTestConfigSchema.parse(
      JSON.parse(readFileSync(join(ws, "config.json"), "utf-8")),
    );
    expect(config.ingress?.publicBaseUrl).toBe("https://second.ngrok-free.app");
  });

  test("maybeStartNgrokTunnel passes the saved domain to the spawn args", async () => {
    const ws = makeWorkspace({ telegram: { botUsername: "example_bot" } });
    realNgrok.saveNgrokDomain("foo.ngrok.app");
    mockNgrokApiFetch([
      null,
      {
        tunnels: [
          unrelatedPortTunnel,
          {
            public_url: "https://foo.ngrok.app",
            config: { addr: "localhost:7830" },
          },
        ],
      },
    ]);

    const child = await realNgrok.maybeStartNgrokTunnel(7830, ws);

    expect(child).not.toBeNull();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnMock.mock.calls[0];
    expect(cmd).toBe("ngrok");
    // Plain `ngrok http` so the user's default config — where their
    // authtoken lives — is what the agent loads.
    expect(args).toEqual([
      "http",
      "127.0.0.1:7830",
      "--log=stdout",
      "--domain=foo.ngrok.app",
    ]);

    const config = IngressTestConfigSchema.parse(
      JSON.parse(readFileSync(join(ws, "config.json"), "utf-8")),
    );
    expect(config.ingress?.publicBaseUrl).toBe("https://foo.ngrok.app");
  });

  test("runNgrokTunnel without --domain reuses the saved domain and does not delete it", async () => {
    const ws = makeWorkspace({});
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

    const run = realNgrok.runNgrokTunnel({ port: 7831, workspaceDir: ws });
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

    const config = IngressTestConfigSchema.parse(
      JSON.parse(readFileSync(join(ws, "config.json"), "utf-8")),
    );
    expect(config.ingress?.publicBaseUrl).toBe("https://foo.ngrok.app");
    expect(realNgrok.loadNgrokDomain()).toBe("foo.ngrok.app");
  });
});

describe("tunnel background mode", () => {
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

  function makeFakeChild(pid: number): ChildProcess {
    const child = new realChildProcess.ChildProcess();
    // kill() stays stubbed: the fake pid must never be signaled for real.
    // stdout/stderr: the real class resolves them through a getter over the
    // internal spawn handle, so null-shadow them via defineProperty — an
    // Object.assign [[Set]] through the getter-only accessor throws.
    Object.defineProperty(child, "stdout", { value: null });
    Object.defineProperty(child, "stderr", { value: null });
    return Object.assign(child, { pid, kill: () => true });
  }

  const spawnMock = mock(
    (
      _command: string,
      _args: readonly string[],
      _options?: SpawnOptions,
    ): ChildProcess => makeFakeChild(9999),
  );

  function detachedLogPath(): string {
    return join(getLogDir(), "tunnel.log");
  }

  beforeAll(() => {
    // The edge-targeting describe's afterAll restores the REAL provider
    // modules; re-establish the fakes the foreground test here needs.
    mock.module("../lib/tunnels/ngrok", () => ({
      ...realNgrok,
      runNgrokTunnel: runNgrokTunnelMock,
      NGROK_PROVIDER: { ...realNgrok.NGROK_PROVIDER, run: runNgrokTunnelMock },
    }));
    mock.module("../lib/nginx-ingress.js", () => ({
      ...realNginxIngress,
      ensureAppServer: ensureAppServerMock,
      getNginxVersion: getNginxVersionMock,
    }));
    mock.module("node:child_process", () => ({
      ...realChildProcess,
      spawn: spawnMock,
    }));
  });

  afterAll(() => {
    mock.module("node:child_process", () => realChildProcess);
    mock.module("../lib/tunnels/ngrok", () => realNgrok);
    mock.module("../lib/nginx-ingress.js", () => realNginxIngress);
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

  test("runs detached by default: re-invokes itself as a detached child and reports readiness", async () => {
    process.argv = ["bun", "cadet", "tunnel", "start", "--provider", "ngrok"];

    // Simulate the detached child writing its readiness line to the log file
    // the moment it is spawned.
    spawnMock.mockImplementationOnce(() => {
      appendFileSync(
        detachedLogPath(),
        "Tunnel established: https://foo.ngrok.app\n",
      );
      return makeFakeChild(9999);
    });

    const logs = await runTunnelCapturingLogs();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, args, opts] = spawnMock.mock.calls[0];
    expect(args).toContain("tunnel");
    expect(args).toContain("--provider");
    expect(args).toContain("ngrok");
    // The child runs the foreground path (it IS the background daemon); the
    // parent must not hand the default through or the child would daemonize
    // again.
    expect(args).toContain("--foreground");
    expect(opts?.detached).toBe(true);

    expect(logs).toContain("Tunnel established: https://foo.ngrok.app");
    expect(logs).toContain("Running in background (pid 9999)");
    expect(logs).toContain("Stop with: cadet tunnel stop");

    // The parent hands the actual tunnel workflow off to the child: it never
    // runs the provider or edge setup itself.
    expect(runNgrokTunnelMock).not.toHaveBeenCalled();
    expect(ensureAppServerMock).not.toHaveBeenCalled();
  });

  test("--foreground runs the tunnel in this process instead of a detached child", async () => {
    process.argv = [
      "bun",
      "cadet",
      "tunnel",
      "start",
      "--provider",
      "ngrok",
      "--foreground",
    ];

    await runTunnelCapturingLogs();

    expect(spawnMock).not.toHaveBeenCalled();
    expect(ensureAppServerMock).toHaveBeenCalled();
    expect(runNgrokTunnelMock).toHaveBeenCalled();
  });

  test("reports an early child exit instead of hanging", async () => {
    process.argv = ["bun", "cadet", "tunnel", "start", "--provider", "ngrok"];
    spawnMock.mockImplementationOnce(() => {
      const child = makeFakeChild(4242);
      // Listeners attach synchronously right after spawn() returns; defer the
      // exit so they're in place before it fires.
      setTimeout(() => child.emit("exit", 1), 0);
      return child;
    });

    const { exited, errors } = await runTunnelExpectingExit1();

    expect(exited).toBe(true);
    expect(errors).toContain("Error (1): tunnel process exited during startup");
    expect(runNgrokTunnelMock).not.toHaveBeenCalled();
  });

  test("an adopted ngrok tunnel gets an accurate stop message, not a false kill claim", async () => {
    process.argv = ["bun", "cadet", "tunnel", "start", "--provider", "ngrok"];
    spawnMock.mockImplementationOnce(() => {
      appendFileSync(
        detachedLogPath(),
        "Found existing ngrok tunnel: https://already-up.ngrok.app\n",
      );
      return makeFakeChild(5555);
    });

    const logs = await runTunnelCapturingLogs();

    expect(logs).toContain("Tunnel established: https://already-up.ngrok.app");
    expect(logs).toContain("Running in background (pid 5555)");
    // The supervisor did not spawn this ngrok agent, so killing it must not
    // be advertised as the way to stop the tunnel.
    expect(logs).not.toContain("Stop with: kill 5555");
    expect(logs).toContain("only");
    expect(logs).toContain("stops this supervisor, not the ngrok tunnel");
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
        start: startTailnetServeMock,
      },
    }));
    mock.module("../lib/nginx-ingress.js", () => ({
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
    startTailnetServeMock.mockReset();
    startTailnetServeMock.mockImplementation(async (opts) => {
      saveIngressUrl(
        opts.workspaceDir,
        TAILNET_URL,
        opts.assistantId,
        "tailscale",
      );
      return TAILNET_URL;
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

  function seedRecordedTailnetWake(): string {
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
      assistantId: entry.assistantId,
      startedAt: new Date().toISOString(),
    });
    return writeEntryWorkspaceConfig(entry, {
      ingress: {
        enabled: true,
        lastTunnel: { provider: "tailscale", publicBaseUrl: TAILNET_URL },
      },
    });
  }

  test("a recorded tailnet tunnel re-establishes the serve at the app server's port and saves the url to each assistant", async () => {
    const workspaceDir = seedRecordedTailnetWake();

    await restoreFlow.restoreAppServerAndAutoTunnel(
      "assistant-1",
      7830,
      workspaceDir,
    );

    // Step 1: the edge started even though the gateway had cleared the url —
    // the lockfile's app entry is why the workspace still wants it.
    expect(ensureAppServerMock).toHaveBeenCalledWith({
      assistantId: "assistant-1",
      workspaceDir,
      gatewayPort: 7830,
    });
    // Step 2: the tunnel re-established at the app server's port, never the
    // gateway's fallback port.
    expect(startTailnetServeMock).toHaveBeenCalledWith({
      port: EDGE_PORT,
      workspaceDir,
      assistantId: "assistant-1",
    });
    // Step 3: the url rode to every locally-reachable assistant's gateway,
    // and the workspace config carries it again.
    expect(notifyGatewayOfPublicUrlMock).toHaveBeenCalledWith(
      TAILNET_URL,
      "assistant-1",
    );
    const saved = JSON.parse(
      readFileSync(join(workspaceDir, "config.json"), "utf-8"),
    ) as { ingress?: { publicBaseUrl?: string } };
    expect(saved.ingress?.publicBaseUrl).toBe(TAILNET_URL);
  });

  test("the fresh url re-ensures the edge so the served config carries it the same wake", async () => {
    const workspaceDir = seedRecordedTailnetWake();
    isIngressRunningMock.mockImplementation(() => true);
    readIngressStateMock.mockImplementation(() => ({
      listenPort: EDGE_PORT,
      gatewayPort: 7830,
    }));

    await restoreFlow.restoreAppServerAndAutoTunnel(
      "assistant-1",
      7830,
      workspaceDir,
    );

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
      assistantId: entry.assistantId,
      startedAt: new Date().toISOString(),
    });
    const workspaceDir = writeEntryWorkspaceConfig(entry, {
      ingress: {
        enabled: true,
        lastTunnel: { provider: "tailscale", publicBaseUrl: TAILNET_URL },
      },
    });

    await restoreFlow.restoreAppServerAndAutoTunnel(
      entry.assistantId,
      7830,
      workspaceDir,
    );

    expect(ensureAppServerMock).toHaveBeenCalled();
    expect(startTailnetServeMock).not.toHaveBeenCalled();
    expect(notifyGatewayOfPublicUrlMock).not.toHaveBeenCalled();
  });

  test("a workspace with no recorded app server wants no edge", async () => {
    const entry = makeLocalEntry();
    writeLockfile(entry);
    const workspaceDir = writeEntryWorkspaceConfig(entry, {
      ingress: { enabled: true },
    });

    await restoreFlow.restoreAppServerAndAutoTunnel(
      entry.assistantId,
      7830,
      workspaceDir,
    );

    expect(ensureAppServerMock).not.toHaveBeenCalled();
    expect(startTailnetServeMock).not.toHaveBeenCalled();
    expect(notifyGatewayOfPublicUrlMock).not.toHaveBeenCalled();
  });

  test("a provider with no start piece ensures nothing", async () => {
    const entry = makeLocalEntry();
    writeLockfile(entry);
    stampRootProcess("tunnel", {
      pid: 4321,
      provider: "cloudflare",
      startedAt: new Date().toISOString(),
    });
    stampRootProcess("app", {
      pid: 4321,
      port: EDGE_PORT,
      assistantId: entry.assistantId,
      startedAt: new Date().toISOString(),
    });
    const workspaceDir = writeEntryWorkspaceConfig(entry, {
      ingress: { enabled: true },
    });

    await restoreFlow.restoreAppServerAndAutoTunnel(
      entry.assistantId,
      7830,
      workspaceDir,
    );

    expect(ensureAppServerMock).toHaveBeenCalled();
    expect(startTailnetServeMock).not.toHaveBeenCalled();
    expect(notifyGatewayOfPublicUrlMock).not.toHaveBeenCalled();
  });
});
