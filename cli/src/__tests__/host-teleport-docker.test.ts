import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as tar from "tar";
import {
  restoreHostTeleportTarget,
  TeleportRecoveryError,
} from "../lib/host-teleport.js";
import { dockerResourceNames } from "../lib/docker.js";
import { DOCKER_STATEFUL_SET_SPEC } from "../lib/statefulset.js";
import { packRoot, STATE_ROOTS } from "../lib/root-backup.js";
import type { LockfileAssistant } from "../lib/assistant-config.js";
import { mockCommands } from "./commands-mock.js";

const entry: LockfileAssistant = {
  assistantId: "destination",
  cloud: "docker",
  runtimeUrl: "http://localhost:7830",
  containerInfo: {
    assistantImage: "image-assistant",
    gatewayImage: "image-gateway",
    cesImage: "image-ces",
    assistantPort: 7821,
  },
};
const names = dockerResourceNames(entry.assistantId);
const containers = {
  assistant: names.assistantContainer,
  gateway: names.gatewayContainer,
  "credential-executor": names.cesContainer,
};
const services: Array<keyof typeof containers> = ["assistant", "gateway", "credential-executor"];
const rootContainer = {
  workspace: names.assistantContainer,
  "gateway-security": names.gatewayContainer,
  "ces-security": names.cesContainer,
  "ces-data": names.cesContainer,
};
let directory: string, archive: string, recovery: string;
let commands: ReturnType<typeof mockCommands>;
let log: ReturnType<typeof spyOn>;
let failReadiness: boolean, failEveryWrite: boolean, writes: number;
let states: Map<string, ReturnType<typeof inspection>>;
function inspection(service: keyof typeof containers) {
  const spec = DOCKER_STATEFUL_SET_SPEC.containers.find(
    (item) => item.internalName === service,
  )!;
  return {
    Id: `${service}-id`,
    Image: `image-${service}`,
    State: { Status: "exited", Running: false },
    Config: {
      User: "1001:1001",
      Env: [
        "ACTOR_TOKEN_SIGNING_KEY=" + "07".repeat(32),
        "CES_SERVICE_TOKEN=internal-test-token",
        "RUNTIME_HTTP_PORT=7821",
        "GATEWAY_PORT=7830",
        "GUARDIAN_BOOTSTRAP_SECRET=bootstrap-test-secret",
      ],
    },
    HostConfig: {
      NetworkMode:
        service === "assistant" ? names.network : "container:assistant-id",
    },
    Mounts: spec.volumeMounts.map((mount) => ({
      Type: "volume",
      Name: DOCKER_STATEFUL_SET_SPEC.volumeClaimTemplates
        .find((volume) => volume.name === mount.volumeName)!
        .dockerVolume(entry.assistantId),
      Source: "/remote/volume",
      Destination: mount.mountPath,
      RW: !mount.readOnly,
    })),
  };
}
const previousDataHome = process.env.XDG_DATA_HOME;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "teleport-docker-"));
  process.env.XDG_DATA_HOME = directory;
  archive = join(directory, "source.tar.gz");
  recovery = join(directory, "recovery.tar.gz");
  for (const flavor of ["source", "original", "volumes"]) {
    for (const root of STATE_ROOTS) {
      await mkdir(join(directory, flavor, root), { recursive: true });
      await writeFile(
        join(directory, flavor, root, "value"),
        flavor === "volumes" ? "original" : flavor,
        { mode: 0o600 },
      );
    }
    await writeFile(
      join(directory, flavor, "gateway-security", "actor-token-signing-key"),
      Buffer.alloc(32, flavor === "source" ? 9 : 7),
    );
    await writeFile(
      join(directory, flavor, "ces-security", "keys.enc"),
      flavor === "source" ? "source ciphertext" : "original ciphertext",
      { mode: 0o600 },
    );
  }
  await packRoot(join(directory, "source"), archive);
  await packRoot(join(directory, "original"), recovery);
  states = new Map(
    services.map((service) => [
      containers[service],
      inspection(service),
    ]),
  );
  failReadiness = false;
  failEveryWrite = false;
  writes = 0;
  log = spyOn(console, "log").mockImplementation(() => {});
  commands = mockCommands();
  commands.on(
    "docker",
    (args) => args[0] === "inspect",
    ({ args }) => {
      const state = states.get(args.at(-1)!);
      if (!state) {
        return { code: 1, stderr: "No such container" };
      }
      if (args.includes("--format")) {
        return {
          stdout:
            args[2] === "{{.State.Status}}"
              ? state.State.Status
              : String(state.State.Running),
        };
      }
      return { stdout: JSON.stringify([state]) };
    },
  );
  commands.on(
    "docker",
    (args) => args[0] === "rm",
    ({ args }) => {
      const state = states.get(args[1]!);
      if (!state) {
        return { code: 1, stderr: "No such container" };
      }
      expect(state.State.Running).toBe(false);
      states.delete(args[1]!);
      return {};
    },
  );
  commands.on(
    "docker",
    (args) => args[0] === "create",
    ({ args }) => {
      const container = args[args.indexOf("--name") + 1]!;
      const service = services.find((service) => containers[service] === container)!;
      const state = inspection(service);
      state.Config.Env = args.flatMap((value, index) =>
        value === "-e" ? [args[index + 1]!] : [],
      );
      states.set(container, state);
      return {};
    },
  );
  commands.on(
    "docker",
    (args) => args[0] === "start",
    ({ args }) => {
      const state = states.get(args[1]!)!;
      state.State.Running = true;
      state.State.Status = "running";
      return {};
    },
  );
  commands.on(
    "docker",
    (args) => args[0] === "kill",
    ({ args }) => {
      expect(args[1]).toBe("--signal=SIGTERM");
      const state = states.get(args.at(-1)!)!;
      state.State.Running = false;
      state.State.Status = "exited";
      return {};
    },
  );
  commands.on(
    "docker",
    (args) => args[0] === "cp",
    async ({ args }) => {
      const root = STATE_ROOTS.find((root) => args[1]!.includes(`:/${root}/`))!;
      expect(
        states.get(rootContainer[root])!.State
          .Running,
      ).toBe(false);
      await cp(join(directory, "volumes", root), args[2]!, { recursive: true });
      return {};
    },
  );
  commands.on(
    "docker",
    (args) => args[0] === "run" && args.includes("-i"),
    async ({ args, input }) => {
      const mount = args[args.indexOf("--mount") + 1]!;
      const root = STATE_ROOTS.find(
        (root) =>
          states
            .get(rootContainer[root])!
            .Mounts.find((item) => item.Destination === `/${root}`)?.Name ===
          mount.split("src=")[1]!.split(",")[0]!,
      )!;
      expect([...states.values()].every((state) => !state.State.Running)).toBe(
        true,
      );
      expect(args).toContain("--network=none");
      expect(args).toContain("--user=0");
      expect(args).toContain("1001:1001");
      expect(args[args.indexOf("-ec") + 1]).toContain('chown -R "$1" /restore');
      writes++;
      if (failEveryWrite) {
        return { code: 1, stderr: "injected volume write failure" };
      }
      const rootDir = join(directory, "volumes", root);
      await rm(rootDir, { recursive: true });
      await mkdir(rootDir);
      await pipeline(
        Readable.from([input]),
        tar.x({ cwd: rootDir, preserveOwner: false }),
      );
      return {};
    },
  );
  commands.on(
    "docker",
    (args) => args[0] === "exec",
    () =>
      failReadiness
        ? { code: 2, stdout: "migration_failed", stderr: "migration_failed" }
        : { stdout: "ready" },
  );
});
afterEach(async () => {
  if (previousDataHome === undefined) {
    delete process.env.XDG_DATA_HOME;
  } else {
    process.env.XDG_DATA_HOME = previousDataHome;
  }
  commands.restore();
  log.mockRestore();
  await rm(directory, { recursive: true, force: true });
});

test("recreates immutable identity overrides and imports all roots before first start", async () => {
  await restoreHostTeleportTarget(entry, archive, recovery);
  for (const root of STATE_ROOTS) {
    expect(
      await readFile(join(directory, "volumes", root, "value"), "utf8"),
    ).toBe("source");
  }
  expect(
    await readFile(
      join(directory, "volumes", "ces-security", "keys.enc"),
      "utf8",
    ),
  ).toBe("source ciphertext");
  expect(
    await readFile(
      join(directory, "volumes", "gateway-security", "actor-token-signing-key"),
    ),
  ).toEqual(Buffer.alloc(32, 9));
  expect(
    [...states.values()].every(
      (state) =>
        !state.Config.Env.some((value) =>
          value.startsWith("ACTOR_TOKEN_SIGNING_KEY="),
        ),
    ),
  ).toBe(true);
  const firstStart = commands.calls.findIndex(
    (request) => request.args[0] === "start",
  );
  const installs = commands.calls
    .map((request, index) => ({ request, index }))
    .filter(
      ({ request }) => request.args[0] === "run" && request.args.includes("-i"),
    );
  expect(installs).toHaveLength(4);
  expect(installs.every(({ index }) => index < firstStart)).toBe(true);
});
test("readiness failure restores original ciphertext, gateway identity, and stopped containers", async () => {
  failReadiness = true;
  await expect(
    restoreHostTeleportTarget(entry, archive, recovery),
  ).rejects.toThrow("did not become ready");
  for (const root of STATE_ROOTS) {
    expect(
      await readFile(join(directory, "volumes", root, "value"), "utf8"),
    ).toBe("original");
  }
  expect(
    await readFile(
      join(directory, "volumes", "ces-security", "keys.enc"),
      "utf8",
    ),
  ).toBe("original ciphertext");
  expect([...states.values()].every((state) => !state.State.Running)).toBe(
    true,
  );
  expect(states.get(names.gatewayContainer)!.Config.Env).toContain(
    "ACTOR_TOKEN_SIGNING_KEY=" + "07".repeat(32),
  );
});
test("unrecoverable writes leave services stopped and report the retained recovery tar", async () => {
  failEveryWrite = true;
  await expect(
    restoreHostTeleportTarget(entry, archive, recovery),
  ).rejects.toBeInstanceOf(TeleportRecoveryError);
  expect([...states.values()].every((state) => !state.State.Running)).toBe(
    true,
  );
  expect(writes).toBeGreaterThan(1);
});
test("customized persistent mounts are rejected before container removal or volume writes", async () => {
  states.get(names.cesContainer)!.Mounts[0]!.Name = "custom-security";
  await expect(
    restoreHostTeleportTarget(entry, archive, recovery),
  ).rejects.toThrow("customized Docker mounts");
  expect(commands.calls.some((request) => request.args[0] === "rm")).toBe(
    false,
  );
  expect(writes).toBe(0);
});
test("legacy vbundle is rejected before touching destination containers", async () => {
  await expect(
    restoreHostTeleportTarget(
      entry,
      join(directory, "legacy.vbundle"),
      recovery,
    ),
  ).rejects.toThrow("vellum-to-cadet");
  expect(commands.calls).toHaveLength(0);
});

test("reads the remote Docker runtime version through in-container health instead of host ports", async () => {
  const { readHostRuntimeVersion } = await import("../lib/host-teleport.js");
  commands.on(
    "docker",
    (args) => args[0] === "exec" && args.at(-1)?.endsWith("/healthz") === true,
    ({ args }) => {
      expect(args[1]).toBe(names.gatewayContainer);
      expect(args.at(-1)).toBe("http://127.0.0.1:7830/healthz");
      return { stdout: JSON.stringify({ version: "0.12.9" }) };
    },
  );
  expect(await readHostRuntimeVersion(entry)).toBe("0.12.9");
});

test("sleeping remote Docker runtime uses its recorded image tag for the version guard", async () => {
  const { readHostRuntimeVersion } = await import("../lib/host-teleport.js");
  commands.on("docker", (args) => args[0] === "exec", {
    code: 1,
    stderr: "container is stopped",
  });
  expect(
    await readHostRuntimeVersion({
      ...entry,
      containerInfo: {
        ...entry.containerInfo!,
        gatewayImage: "mycadet/gateway:0.12.8",
      },
    }),
  ).toBe("0.12.8");
});
