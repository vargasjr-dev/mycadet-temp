import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as processes from "../lib/process.js";
import {
  TAILSCALE_PROVIDER,
  stopTailscaleTunnel,
  type TailscaleDeps,
} from "../lib/tunnels/tailscale.js";
import * as ngrok from "../lib/tunnels/ngrok.js";
import { tunnel } from "../commands/tunnel.js";
import {
  readRootProcesses,
  saveLockfileAssistant,
  stampRootProcess,
} from "../lib/assistant-config.js";

const originalArgv = process.argv;
const originalLock = process.env.CADET_LOCKFILE_DIR;
const originalConfig = process.env.XDG_CONFIG_HOME;
let root = "";
let workspace = "";
let stop: ReturnType<typeof spyOn<typeof processes, "stopProcess">>;
let identity: ReturnType<
  typeof spyOn<typeof processes, "readProcessCommandLine">
>;
let logs: ReturnType<typeof spyOn<typeof console, "log">>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cadet-tunnel-stop-"));
  workspace = join(root, "instance", "workspace");
  mkdirSync(workspace, { recursive: true });
  process.env.CADET_LOCKFILE_DIR = root;
  process.env.XDG_CONFIG_HOME = root;
  saveLockfileAssistant({
    assistantId: "fixture",
    name: "fixture",
    cloud: "local",
    runtimeUrl: "http://127.0.0.1:7830",
    resources: {
      instanceDir: join(root, "instance"),
      gatewayPort: 7830,
      daemonPort: 7821,
      cesPort: 8090,
    },
  });
  writeFileSync(
    join(workspace, "config.json"),
    JSON.stringify({
      ingress: {
        publicBaseUrl: "https://old.ngrok.app",
        lastTunnel: {
          provider: "ngrok",
          publicBaseUrl: "https://old.ngrok.app",
        },
      },
    }),
  );
  stampRootProcess("tunnel", {
    pid: 424242,
    provider: "ngrok",
    startedAt: new Date().toISOString(),
  });
  stampRootProcess("app", {
    pid: 424243,
    port: 7841,
    startedAt: new Date().toISOString(),
  });
  ngrok.saveNgrokDomain("old.ngrok.app");
  stop = spyOn(processes, "stopProcess").mockResolvedValue(true);
  identity = spyOn(processes, "readProcessCommandLine").mockReturnValue(
    "ngrok http 7840",
  );
  logs = spyOn(console, "log").mockImplementation(() => {});
  process.argv = ["bun", "cadet", "tunnel", "stop"];
});
afterEach(() => {
  stop.mockRestore();
  identity.mockRestore();
  logs.mockRestore();
  process.argv = originalArgv;
  if (originalLock === undefined) delete process.env.CADET_LOCKFILE_DIR;
  else process.env.CADET_LOCKFILE_DIR = originalLock;
  if (originalConfig === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalConfig;
  rmSync(root, { recursive: true, force: true });
});

test("stop terminates the owned agent and clears ingress, retaining nginx and domain; repeated stop is harmless", async () => {
  await tunnel();
  expect(stop).toHaveBeenCalledWith(424242, "tunnel");
  expect(readRootProcesses().tunnel).toBeUndefined();
  expect(readRootProcesses().app?.pid).toBe(424243);
  expect(
    JSON.parse(readFileSync(join(workspace, "config.json"), "utf8")).ingress
      .publicBaseUrl,
  ).toBeUndefined();
  expect(ngrok.loadNgrokDomain()).toBe("old.ngrok.app");
  await tunnel();
  expect(stop).toHaveBeenCalledTimes(1);
});
test("a recycled PID is not signaled and its stale record is cleared", async () => {
  identity.mockReturnValue("unrelated-process");
  await tunnel();
  expect(stop).not.toHaveBeenCalled();
  expect(readRootProcesses().tunnel).toBeUndefined();
});
test("failure to stop retains process and ingress state", async () => {
  stop.mockResolvedValue(false);
  await expect(tunnel()).rejects.toThrow("Could not stop ngrok");
  expect(readRootProcesses().tunnel?.pid).toBe(424242);
});

test("Cloudflare dispatch stops cloudflared and clears its ingress", async () => {
  stampRootProcess("tunnel", {
    pid: 424242,
    provider: "cloudflare",
    startedAt: new Date().toISOString(),
  });
  identity.mockReturnValue(
    "/usr/local/bin/cloudflared tunnel --url http://localhost:7840",
  );
  await tunnel();
  expect(stop).toHaveBeenCalledWith(424242, "tunnel");
  expect(readRootProcesses().tunnel).toBeUndefined();
});

test("Tailscale dispatch disables serve and preserves the webhook ingress base", async () => {
  stampRootProcess("tunnel", {
    pid: 424242,
    provider: "tailscale",
    startedAt: new Date().toISOString(),
  });
  writeFileSync(
    join(workspace, "config.json"),
    JSON.stringify({
      ingress: {
        publicBaseUrl: "https://old.ngrok.app",
        pairingTunnel: { provider: "tailscale" },
      },
    }),
  );
  const calls: string[][] = [];
  const deps: TailscaleDeps = {
    findBinary: async () => "tailscale",
    run: (_bin, args) => {
      calls.push(args);
      return { status: 0, stdout: "", stderr: "" };
    },
  };
  const provider = spyOn(TAILSCALE_PROVIDER, "stop").mockImplementation(
    (opts) => stopTailscaleTunnel(opts, deps),
  );
  try {
    await tunnel();
    expect(calls).toEqual([["serve", "--https=443", "off"]]);
    expect(stop).not.toHaveBeenCalled();
    expect(readRootProcesses().tunnel).toBeUndefined();
    const state = JSON.parse(
      readFileSync(join(workspace, "config.json"), "utf8"),
    );
    expect(state.ingress.publicBaseUrl).toBe("https://old.ngrok.app");
    expect(state.ingress.pairingTunnel).toBeUndefined();
  } finally {
    provider.mockRestore();
  }
});

test("Tailscale shutdown failure preserves the recorded tunnel and ingress", async () => {
  stampRootProcess("tunnel", {
    pid: 424242,
    provider: "tailscale",
    startedAt: new Date().toISOString(),
  });
  const deps: TailscaleDeps = {
    findBinary: async () => "tailscale",
    run: () => ({ status: 1, stdout: "", stderr: "permission denied" }),
  };
  const provider = spyOn(TAILSCALE_PROVIDER, "stop").mockImplementation(
    (opts) => stopTailscaleTunnel(opts, deps),
  );
  try {
    await expect(tunnel()).rejects.toThrow("Could not stop tailscale serve");
    expect(readRootProcesses().tunnel?.provider).toBe("tailscale");
  } finally {
    provider.mockRestore();
  }
});
