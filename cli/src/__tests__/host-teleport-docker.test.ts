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
import { initializeDockerTeleportTarget } from "../lib/remotes/docker.js";
import { resolveOwnImageRefs } from "@mycadet/local-mode";
import cliPkg from "../../package.json";

import { DOCKER_STATEFUL_SET_SPEC } from "@mycadet/local-mode";
import { packRoot, STATE_ROOTS } from "../lib/root-backup.js";
import type {
  DockerAssistant,
  LockfileAssistant,
} from "@mycadet/local-mode/contract";
import * as localMode from "@mycadet/local-mode";
import { mockCommands } from "./commands-mock.js";
import { dockerResourceNames } from "@mycadet/local-mode";

const entry: LockfileAssistant = {
  assistantId: "destination",
  cloud: "docker",
  port: 7830,
  containerInfo: {
    assistantImage: "image-assistant",
    gatewayImage: "image-gateway",
    cesImage: "image-ces",
  },
};
const names = dockerResourceNames(entry.assistantId);
const containers = {
  assistant: names.assistantContainer,
  gateway: names.gatewayContainer,
  "credential-executor": names.cesContainer,
};
const services: Array<keyof typeof containers> = [
  "assistant",
  "gateway",
  "credential-executor",
];
// Volume suffixes per state root (dockerResourceNames' shape) — the mounts
// always carry them after the instance-name prefix.
const ROOT_VOLUMES: Record<(typeof STATE_ROOTS)[number], string> = {
  workspace: "workspace",
  "gateway-security": "gateway-sec",
  "ces-security": "ces-sec",
  "ces-data": "ces-data",
};
const rootContainer = {
  workspace: names.assistantContainer,
  "gateway-security": names.gatewayContainer,
  "ces-security": names.cesContainer,
  "ces-data": names.cesContainer,
};
let directory: string, archive: string, recovery: string;
let commands: ReturnType<typeof mockCommands>;
let wakeSpy: ReturnType<typeof spyOn> | undefined;
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
    services.map((service) => [containers[service], inspection(service)]),
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
      expect(states.get(rootContainer[root])!.State.Running).toBe(false);
      await cp(join(directory, "volumes", root), args[2]!, { recursive: true });
      return {};
    },
  );
  commands.on(
    "docker",
    (args) => args[0] === "run" && args.includes("-i"),
    async ({ args, input }) => {
      const mount = args[args.indexOf("--mount") + 1]!;
      const volumeName = mount.split("src=")[1]!.split(",")[0]!;
      const root = STATE_ROOTS.find((root) =>
        volumeName.endsWith(`-${ROOT_VOLUMES[root]}`),
      );
      expect(root).toBeDefined();
      expect([...states.values()].every((state) => !state.State.Running)).toBe(
        true,
      );
      expect(args).toContain("--network=none");
      expect(args).toContain("--user=0");
      // Destination-owned extraction: the archive never brings a uid.
      expect(args.at(-1)).toMatch(/^[\w.-]+:[\w.-]+$/);
      expect(args[args.indexOf("-ec") + 1]).toContain('chown -R "$1" /restore');
      writes++;
      if (failEveryWrite) {
        return { code: 1, stderr: "injected volume write failure" };
      }
      const rootDir = join(directory, "volumes", root!);
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
  wakeSpy?.mockRestore();
  wakeSpy = undefined;
  commands.restore();
  log.mockRestore();
  await rm(directory, { recursive: true, force: true });
});

test("imports all roots before the first start", async () => {
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
test("readiness failure restores the recovery archive and leaves services stopped", async () => {
  // The in-container probes died with the resume method; the wake's own
  // readiness failure is the trigger now.
  wakeSpy = spyOn(localMode, "wakeAssistant").mockRejectedValue(
    new Error("containers did not become ready"),
  );
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

test("a fresh docker target initializes the volumes without creating containers", async () => {
  // No containers exist yet for a fresh target — the inspect handler's
  // "No such container" answer drives the storage through its spec-derived
  // mounts, and the init must never create or start a container itself.
  states.clear();
  const openPort = spyOn(localMode, "findOpenPort")
    .mockResolvedValueOnce(7830)
    .mockResolvedValueOnce(7821);
  const pull = spyOn(localMode, "pullImage").mockResolvedValue(undefined);
  const save = spyOn(localMode, "saveLockfileAssistant").mockImplementation(
    async () => undefined as never,
  );
  let writesAtSave = -1;
  save.mockImplementation(async () => {
    writesAtSave = writes;
    return undefined as never;
  });
  // The busybox chown run carries no -i, so it needs its own arm (the -i
  // installs keep riding the beforeEach harness).
  commands.on(
    "docker",
    (args) => args[0] === "run" && !args.includes("-i"),
    () => ({}),
  );
  commands.on(
    "docker",
    (args) => args[0] === "network",
    () => ({}),
  );
  commands.on(
    "docker",
    (args) => args[0] === "volume",
    () => ({}),
  );
  commands.on(
    "docker",
    (args) => args[0] === "info",
    () => ({}),
  );
  commands.on(
    "docker",
    (args) => args[0] === "--version",
    () => ({
      stdout: "Docker version 27.0.0, build 1",
    }),
  );

  try {
    const hatched = await initializeDockerTeleportTarget(
      "fresh-target",
      archive,
    );
    expect(hatched.cloud).toBe("docker");
    const entry = hatched as DockerAssistant;

    const refs = resolveOwnImageRefs(cliPkg.version);
    expect(entry.port).toBe(7830);
    expect(entry.daemonPort).toBe(7821);
    expect(entry.hatchedAt).toBeTruthy();
    expect(entry.containerInfo).toEqual({
      assistantImage: refs.assistant,
      gatewayImage: refs.gateway,
      cesImage: refs["credential-executor"],
    });
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ assistantId: "fresh-target" }),
      "fresh-target",
    );
    // The data landed before the entry was persisted.
    expect(writesAtSave).toBe(4);
    for (const root of STATE_ROOTS) {
      expect(
        await readFile(join(directory, "volumes", root, "value"), "utf8"),
      ).toBe("source");
    }
    // initialize-data only: no container is ever created or started here —
    // the wake's recreate owns the containers from the recorded images.
    expect(
      commands.calls.some((request) =>
        ["create", "start"].includes(request.args[0] ?? ""),
      ),
    ).toBe(false);
  } finally {
    openPort.mockRestore();
    pull.mockRestore();
    save.mockRestore();
  }
});
