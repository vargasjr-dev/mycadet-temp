import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  AVATAR_DEVICE_ENV_VAR,
  buildServiceRunArgs,
  getBuilderManagedEnvKeys,
  resolveAvatarDevicePath,
  type BuildServiceRunArgsOpts,
  type DockerStatefulSetSpec,
  type ServiceName,
} from "../remotes/docker/statefulset";
import { dockerResourceNames } from "../remotes/docker/retire";
import { ASSISTANT_INTERNAL_PORT } from "../ports";
import { PROVIDER_ENV_VAR_NAMES } from "../provider-env-vars";

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

const SECRET_KEYS = ["CES_SERVICE_TOKEN"];

describe("getBuilderManagedEnvKeys", () => {
  test("gateway always-set keys cover spec static + secret entries and PATH", () => {
    const { always } = getBuilderManagedEnvKeys("gateway");

    const expected = [
      "CADET_WORKSPACE_DIR",
      "GATEWAY_SECURITY_DIR",
      "CES_CREDENTIAL_URL",
      "GATEWAY_IPC_SOCKET_DIR",
      "ASSISTANT_IPC_SOCKET_DIR",
      "GATEWAY_PORT",
      "RUNTIME_HTTP_PORT",
      ...SECRET_KEYS,
      "PATH",
    ];
    for (const key of expected) {
      expect(always.has(key)).toBe(true);
    }

    expect(always.has("CADET_DEVICE_ID")).toBe(false);
  });

  test("assistant always-set keys include secrets and builder-computed extras", () => {
    const { always } = getBuilderManagedEnvKeys("assistant");

    const expected = [
      ...SECRET_KEYS,
      "CADET_ASSISTANT_NAME",
      "GATEWAY_INTERNAL_URL",
      "RUNTIME_HTTP_HOST",
      "PATH",
    ];
    for (const key of expected) {
      expect(always.has(key)).toBe(true);
    }
  });

  test("gateway hostForwarded equals the three spec host entries", () => {
    const { hostForwarded } = getBuilderManagedEnvKeys("gateway");
    const sorted = [...hostForwarded].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    expect(sorted).toEqual([
      { name: "CADET_CLOUD_URL", hostVar: "CADET_CLOUD_URL" },
      { name: "CADET_ENVIRONMENT", hostVar: "CADET_ENVIRONMENT" },
      { name: "TUNNEL_BASE_URL", hostVar: "TUNNEL_BASE_URL" },
    ]);
  });

  test("assistant hostForwarded includes provider keys and platform URL", () => {
    const { hostForwarded } = getBuilderManagedEnvKeys("assistant");
    expect(hostForwarded).toContainEqual({
      name: "ANTHROPIC_API_KEY",
      hostVar: "ANTHROPIC_API_KEY",
    });
    for (const envVar of Object.values(PROVIDER_ENV_VAR_NAMES)) {
      expect(hostForwarded).toContainEqual({ name: envVar, hostVar: envVar });
    }
    expect(hostForwarded).toContainEqual({
      name: "CADET_CLOUD_URL",
      hostVar: "CADET_CLOUD_URL",
    });
  });

  test("hostForwarded keeps container name when hostVar differs", () => {
    const spec: DockerStatefulSetSpec = {
      startOrder: ["gateway"],
      readiness: { endpoint: "/readyz", timeoutMs: 1, intervalMs: 1 },
      volumeClaimTemplates: [],
      containers: [
        {
          name: "gateway-sidecar",
          internalName: "gateway",
          network: "container",
          env: [{ kind: "host", name: "CONTAINER_NAME", hostVar: "HOST_NAME" }],
          volumeMounts: [],
        },
      ],
    };

    const { hostForwarded } = getBuilderManagedEnvKeys("gateway", spec);
    expect(hostForwarded).toEqual([
      { name: "CONTAINER_NAME", hostVar: "HOST_NAME" },
    ]);
  });

  test("throws on unknown service name", () => {
    expect(() => getBuilderManagedEnvKeys("bogus" as ServiceName)).toThrow(
      'docker-statefulset: unknown service "bogus"',
    );
  });
});

describe("buildServiceRunArgs extra env routing", () => {
  const opts: BuildServiceRunArgsOpts = {
    gatewayPort: 18080,
    imageTags: {
      assistant: "assistant:test",
      gateway: "gateway:test",
      "credential-executor": "ces:test",
    },
    instanceName: "test-instance",
    res: {
      assistantContainer: "test-assistant",
      cesContainer: "test-ces",
      gatewayContainer: "test-gateway",
      network: "test-net",
    },
    extraGatewayEnv: { BAR: "1" },
    extraAssistantEnv: { FOO: "bar" },
  };

  const runArgs = buildServiceRunArgs(opts);

  test("extraGatewayEnv lands only in gateway args", () => {
    const gatewayArgs = runArgs.gateway();
    expect(gatewayArgs).toContain("BAR=1");
    expect(gatewayArgs).not.toContain("FOO=bar");
  });

  test("extraAssistantEnv lands only in assistant args", () => {
    const assistantArgs = runArgs.assistant();
    expect(assistantArgs).toContain("FOO=bar");
    expect(assistantArgs).not.toContain("BAR=1");
  });

  test("credential-executor args get neither extra env map", () => {
    const cesArgs = runArgs["credential-executor"]();
    expect(cesArgs).not.toContain("BAR=1");
    expect(cesArgs).not.toContain("FOO=bar");
  });

  test("credential-executor args carry the /ces-security and /ces-data wiring", () => {
    const cesArgs = runArgs["credential-executor"]();
    expect(cesArgs).toContain("CREDENTIAL_SECURITY_DIR=/ces-security");
    expect(cesArgs).toContain("CES_DATA_DIR=/ces-data");
  });
});

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
