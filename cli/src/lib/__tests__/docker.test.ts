import { afterEach, beforeEach, describe, test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  AVATAR_DEVICE_ENV_VAR,
  collectWatchTargets,
  pullImage,
  resolveAvatarDevicePath,
  resolveDockerHatchMode,
  resolveDockerProviderCredentialSetupAction,
  type ServiceName,
} from "../remotes/docker.js";
import { dockerResourceNames } from "@mycadet/local-mode";
import { ASSISTANT_INTERNAL_PORT } from "../environments/paths.js";
import { buildServiceRunArgs } from "../statefulset.js";

const instanceName = "test-instance";
const imageTags: Record<ServiceName, string> = {
  assistant: "mycadet/mycadet:test",
  "credential-executor": "mycadet/cadet-credential-executor:test",
  gateway: "mycadet/cadet-gateway:test",
};

function buildAssistantArgs(
  overrides: Partial<Parameters<typeof buildServiceRunArgs>[0]> = {},
): string[] {
  const res = dockerResourceNames(instanceName);
  const builders = buildServiceRunArgs({
    gatewayPort: 7830,
    imageTags,
    instanceName,
    res,
    ...overrides,
  });
  return builders.assistant();
}

function buildGatewayArgs(
  overrides: Partial<Parameters<typeof buildServiceRunArgs>[0]> = {},
): string[] {
  const res = dockerResourceNames(instanceName);
  const builders = buildServiceRunArgs({
    gatewayPort: 7830,
    imageTags,
    instanceName,
    res,
    ...overrides,
  });
  return builders.gateway();
}

describe("buildServiceRunArgs — assistant", () => {
  test("does not grant elevated capabilities or disable security profiles", () => {
    const args = buildAssistantArgs();
    expect(args).not.toContain("--privileged");
    expect(args).not.toContain("--cap-add");
    expect(args).not.toContain("SYS_ADMIN");
    expect(args).not.toContain("NET_ADMIN");
    expect(args).not.toContain("seccomp=unconfined");
    expect(args).not.toContain("apparmor=unconfined");
  });

  test("does not mount a dockerd data volume", () => {
    const args = buildAssistantArgs();
    expect(args.some((a) => a.includes("/var/lib/docker"))).toBe(false);
  });

  test("does NOT bind-mount the host Docker socket", () => {
    const args = buildAssistantArgs();
    expect(args).not.toContain("/var/run/docker.sock:/var/run/docker.sock");
  });

  test("keeps existing workspace and socket volume mounts intact", () => {
    const args = buildAssistantArgs();
    expect(args).toContain(`${instanceName}-workspace:/workspace`);
    expect(args).toContain(`${instanceName}-socket:/run/ces-bootstrap`);
  });

  test("preserves existing required env vars", () => {
    const args = buildAssistantArgs();
    expect(args).toContain("IS_CONTAINERIZED=true");
    expect(args).toContain("CADET_WORKSPACE_DIR=/workspace");
    expect(args).toContain("CES_BOOTSTRAP_SOCKET_DIR=/run/ces-bootstrap");
    expect(args).toContain(`CADET_ASSISTANT_NAME=${instanceName}`);
  });

  test("publishes the assistant HTTP port loopback-only — the same-pod gateway and host-local tooling are the only callers", () => {
    const args = buildAssistantArgs();
    // The port mapping is expressed as two adjacent args: "-p" then the spec.
    // Bound to `127.0.0.1:` — the assistant HTTP API serves the gateway (same
    // pod) and host-local tooling; the gateway's edge is the only ingress, so
    // the API never faces the LAN.
    const portSpec = `127.0.0.1:${ASSISTANT_INTERNAL_PORT}:${ASSISTANT_INTERNAL_PORT}`;
    const portIndex = args.indexOf(portSpec);
    expect(portIndex).toBeGreaterThan(0);
    expect(args[portIndex - 1]).toBe("-p");
  });
});

describe("buildServiceRunArgs — machine memory policy", () => {
  test("no policy = no memory flags, exactly the historical launch", () => {
    const args = buildAssistantArgs();
    expect(args).not.toContain("--memory");
    expect(args).not.toContain("--memory-reservation");
    expect(args).not.toContain("--memory-swap");
  });

  test("a stored policy flags the ASSISTANT container only", () => {
    const max = 8 * 1024 ** 3;
    const high = 6 * 1024 ** 3;
    const args = buildAssistantArgs({
      assistantMemory: { max, high },
    });
    expect(args).toContain("--memory");
    expect(args).toContain(String(max));
    expect(args).toContain("--memory-swap");
    expect(args).toContain("--memory-reservation");
    expect(args).toContain(String(high));

    const gatewayArgs = buildGatewayArgs({
      assistantMemory: { max, high },
    });
    expect(gatewayArgs).not.toContain("--memory");
    expect(gatewayArgs).not.toContain("--memory-reservation");
    expect(gatewayArgs).not.toContain("--memory-swap");
  });

  test("a soft-limit-only policy emits no hard cap", () => {
    const high = 4 * 1024 ** 3;
    const args = buildAssistantArgs({ assistantMemory: { high } });
    expect(args).toContain("--memory-reservation");
    expect(args).toContain(String(high));
    expect(args).not.toContain("--memory");
    expect(args).not.toContain("--memory-swap");
  });
});

describe("resolveDockerProviderCredentialSetupAction", () => {
  test("defers provider setup in detached mode", () => {
    expect(
      resolveDockerProviderCredentialSetupAction({
        provider: "anthropic",
        detached: true,
      }),
    ).toBe("defer");
  });

  test("reports missing guardian token only when a lease was expected", () => {
    expect(
      resolveDockerProviderCredentialSetupAction({
        provider: "anthropic",
        detached: false,
      }),
    ).toBe("missing-token");
  });

  test("configures provider setup when a guardian token is available", () => {
    expect(
      resolveDockerProviderCredentialSetupAction({
        provider: "anthropic",
        guardianAccessToken: "guardian-token",
        detached: false,
      }),
    ).toBe("configure");
  });

  test("skips provider setup for internal hatches and detached keyless hatches", () => {
    expect(
      resolveDockerProviderCredentialSetupAction({
        provider: undefined,
        detached: false,
      }),
    ).toBe("skip");
    expect(
      resolveDockerProviderCredentialSetupAction({
        provider: null,
        detached: true,
      }),
    ).toBe("skip");
  });

  test("detached hatch with a pre-collected key configures instead of deferring", () => {
    expect(
      resolveDockerProviderCredentialSetupAction({
        provider: "fireworks",
        guardianAccessToken: "guardian-token",
        detached: true,
        precollectedKey: "fw-key-123",
      }),
    ).toBe("configure");
  });

  test("pre-collected key without a guardian token reports missing-token (no silent defer)", () => {
    expect(
      resolveDockerProviderCredentialSetupAction({
        provider: "fireworks",
        detached: true,
        precollectedKey: "fw-key-123",
      }),
    ).toBe("missing-token");
  });

  test("an explicitly skipped key still counts as answered — configure runs and reports the gap", () => {
    expect(
      resolveDockerProviderCredentialSetupAction({
        provider: "fireworks",
        guardianAccessToken: "guardian-token",
        detached: true,
        precollectedKey: "",
      }),
    ).toBe("configure");
  });
});

describe("buildServiceRunArgs — gateway", () => {
  const savedTunnelBaseUrl = process.env.TUNNEL_BASE_URL;

  beforeEach(() => {
    delete process.env.TUNNEL_BASE_URL;
  });

  afterEach(() => {
    if (savedTunnelBaseUrl === undefined) delete process.env.TUNNEL_BASE_URL;
    else process.env.TUNNEL_BASE_URL = savedTunnelBaseUrl;
  });

  test("passes TUNNEL_BASE_URL into the gateway container when set", () => {
    process.env.TUNNEL_BASE_URL = "http://host.docker.internal:8501";

    expect(buildGatewayArgs()).toContain(
      "TUNNEL_BASE_URL=http://host.docker.internal:8501",
    );
  });

  test("omits TUNNEL_BASE_URL from gateway args when unset", () => {
    expect(
      buildGatewayArgs().some((arg) => arg.startsWith("TUNNEL_BASE_URL=")),
    ).toBe(false);
  });

  test("forces gateway to run as uid 0 so it can connect to the assistant's root-owned IPC socket (mirrors K8s securityContext.runAsUser=0)", () => {
    const args = buildGatewayArgs();
    const userIdx = args.indexOf("--user");
    expect(userIdx).toBeGreaterThan(-1);
    expect(args[userIdx + 1]).toBe("0");
  });

  test("assistant container does NOT get a --user override (image USER root wins)", () => {
    expect(buildAssistantArgs().includes("--user")).toBe(false);
  });
});

describe("CADET_AVATAR_DEVICE passthrough", () => {
  const savedValue = process.env[AVATAR_DEVICE_ENV_VAR];

  beforeEach(() => {
    delete process.env[AVATAR_DEVICE_ENV_VAR];
  });

  afterEach(() => {
    if (savedValue === undefined) delete process.env[AVATAR_DEVICE_ENV_VAR];
    else process.env[AVATAR_DEVICE_ENV_VAR] = savedValue;
  });

  test("resolveAvatarDevicePath returns default when env var is unset", () => {
    expect(resolveAvatarDevicePath({})).toBe("/dev/video10");
  });

  test("resolveAvatarDevicePath honors override", () => {
    expect(
      resolveAvatarDevicePath({ [AVATAR_DEVICE_ENV_VAR]: "/dev/video11" }),
    ).toBe("/dev/video11");
  });

  test("assistant args omit --device and env var when device node is absent", () => {
    const args = buildAssistantArgs();
    expect(args).not.toContain("--device");
    expect(args.some((a) => a.startsWith(`${AVATAR_DEVICE_ENV_VAR}=`))).toBe(
      false,
    );
  });
});

describe("resolveDockerHatchMode", () => {
  test("defaults to pulling published images when no source flag is set", () => {
    expect(
      resolveDockerHatchMode({
        watch: false,
        buildFromSource: false,
        fullSourceTreeAvailable: true,
      }),
    ).toEqual({ build: false, watcher: false, fellBackToPull: false });
  });

  test("--source <path> builds without enabling the file watcher", () => {
    expect(
      resolveDockerHatchMode({
        watch: false,
        buildFromSource: true,
        fullSourceTreeAvailable: true,
      }),
    ).toEqual({ build: true, watcher: false, fellBackToPull: false });
  });

  test("--watch builds and enables the file watcher", () => {
    expect(
      resolveDockerHatchMode({
        watch: true,
        buildFromSource: false,
        fullSourceTreeAvailable: true,
      }),
    ).toEqual({ build: true, watcher: true, fellBackToPull: false });
  });

  test("--watch + --source <path> still enables the watcher (watch wins)", () => {
    expect(
      resolveDockerHatchMode({
        watch: true,
        buildFromSource: true,
        fullSourceTreeAvailable: true,
      }),
    ).toEqual({ build: true, watcher: true, fellBackToPull: false });
  });

  test("falls back to pull when source flag is set but source tree is missing", () => {
    expect(
      resolveDockerHatchMode({
        watch: false,
        buildFromSource: true,
        fullSourceTreeAvailable: false,
      }),
    ).toEqual({ build: false, watcher: false, fellBackToPull: true });
    expect(
      resolveDockerHatchMode({
        watch: true,
        buildFromSource: false,
        fullSourceTreeAvailable: false,
      }),
    ).toEqual({ build: false, watcher: false, fellBackToPull: true });
  });
});

describe("collectWatchTargets", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "cadet-watch-"));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function scaffold(
    relDir: string,
    { src = true, pkg = true, dockerfile = false } = {},
  ): void {
    mkdirSync(join(repoRoot, relDir), { recursive: true });
    if (src) mkdirSync(join(repoRoot, relDir, "src"), { recursive: true });
    if (pkg) writeFileSync(join(repoRoot, relDir, "package.json"), "{}");
    if (dockerfile) writeFileSync(join(repoRoot, relDir, "Dockerfile"), "");
  }

  test("scopes watch targets to src/, package.json, and the Dockerfile", () => {
    // GIVEN the three services (each with a Dockerfile) plus a couple of
    // shared packages (libraries, no Dockerfile)
    scaffold("assistant", { dockerfile: true });
    scaffold("credential-executor", { dockerfile: true });
    scaffold("gateway", { dockerfile: true });
    scaffold("packages/service-contracts");
    scaffold("packages/local-mode");

    // WHEN we collect the watch targets
    const { dirs, files } = collectWatchTargets(repoRoot);

    // THEN only the src/ directories are watched recursively
    expect(dirs.sort()).toEqual(
      [
        join(repoRoot, "assistant", "src"),
        join(repoRoot, "credential-executor", "src"),
        join(repoRoot, "gateway", "src"),
        join(repoRoot, "packages", "local-mode", "src"),
        join(repoRoot, "packages", "service-contracts", "src"),
      ].sort(),
    );

    // AND the package.json manifests and service Dockerfiles are watched as
    // individual files (packages have no Dockerfile, so none is emitted)
    expect(files.sort()).toEqual(
      [
        join(repoRoot, "assistant", "package.json"),
        join(repoRoot, "assistant", "Dockerfile"),
        join(repoRoot, "credential-executor", "package.json"),
        join(repoRoot, "credential-executor", "Dockerfile"),
        join(repoRoot, "gateway", "package.json"),
        join(repoRoot, "gateway", "Dockerfile"),
        join(repoRoot, "packages", "local-mode", "package.json"),
        join(repoRoot, "packages", "service-contracts", "package.json"),
      ].sort(),
    );
  });

  test("never watches .claude/ command symlinks that crash the watcher", () => {
    // GIVEN an assistant service whose .claude/commands holds a dangling
    // symlink (as it does in a fresh checkout)
    scaffold("assistant");
    mkdirSync(join(repoRoot, "assistant", ".claude", "commands"), {
      recursive: true,
    });
    symlinkSync(
      join(repoRoot, "does-not-exist", "do.md"),
      join(repoRoot, "assistant", ".claude", "commands", "do.md"),
    );

    // WHEN we collect the watch targets
    const { dirs, files } = collectWatchTargets(repoRoot);

    // THEN no watched path reaches into the .claude/ tree
    const all = [...dirs, ...files];
    expect(all.some((p) => p.includes(".claude"))).toBe(false);
    expect(dirs).toContain(join(repoRoot, "assistant", "src"));
  });

  test("skips roots missing a src/ directory or package.json", () => {
    // GIVEN a service with only a manifest and a package with only a src/ dir
    scaffold("gateway", { src: false, pkg: true });
    scaffold("packages/contracts-only", { src: true, pkg: false });

    // WHEN we collect the watch targets
    const { dirs, files } = collectWatchTargets(repoRoot);

    // THEN absent paths are not emitted
    expect(dirs).toEqual([join(repoRoot, "packages", "contracts-only", "src")]);
    expect(files).toEqual([join(repoRoot, "gateway", "package.json")]);
  });
});

describe("pullImage", () => {
  function fakePull(
    opts: {
      failFirstPullWith?: string;
      failAllPullsWith?: string;
    } = {},
  ) {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    let pulls = 0;
    const exec = async (cmd: string, args: string[] = []): Promise<void> => {
      calls.push({ cmd, args });
      if (cmd === "docker" && args[0] === "pull") {
        pulls++;
        if (opts.failAllPullsWith) throw new Error(opts.failAllPullsWith);
        if (opts.failFirstPullWith && pulls === 1) {
          throw new Error(opts.failFirstPullWith);
        }
      }
      // `docker logout` (and anything else) succeeds silently.
    };
    const ran = (sub: string): boolean =>
      calls.some((c) => c.cmd === "docker" && c.args[0] === sub);
    return { exec, ran };
  }

  test("pulls without touching stored credentials on success", async () => {
    const { exec, ran } = fakePull();

    await pullImage("mycadet/mycadet-assistant:v1", () => {}, exec);

    expect(ran("pull")).toBe(true);
    expect(ran("logout")).toBe(false);
  });

  test("clears stale Docker Hub credentials and retries once on an expired-token error", async () => {
    const { exec, ran } = fakePull({
      failFirstPullWith:
        "Error response from daemon: authentication required - personal access token is expired",
    });

    await pullImage("mycadet/mycadet-assistant:v1", () => {}, exec);

    expect(ran("logout")).toBe(true);
  });

  test("wraps the failure with actionable copy when the auth retry also fails", () => {
    const { exec } = fakePull({
      failAllPullsWith:
        "Error response from daemon: authentication required - personal access token is expired",
    });

    expect(
      pullImage("mycadet/mycadet-assistant:v1", () => {}, exec),
    ).rejects.toThrow("Failed to pull mycadet/mycadet-assistant:v1");
  });

  test("rethrows non-auth pull errors raw and never logs out", () => {
    const { exec, ran } = fakePull({
      failAllPullsWith:
        "Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
    });

    expect(
      pullImage("mycadet/mycadet-assistant:v1", () => {}, exec),
    ).rejects.toThrow("Cannot connect to the Docker daemon");
    expect(ran("logout")).toBe(false);
  });
});
