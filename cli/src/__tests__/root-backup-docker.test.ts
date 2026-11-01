import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as tar from "tar";
import {
  DockerRootStorage,
  packRoot,
  restoreRootBackup,
  stageRootArchive,
  STATE_ROOTS,
} from "../lib/root-backup.js";
import { startContainers } from "../lib/remotes/docker.js";
import { dockerResourceNames, sleepDocker } from "@mycadet/local-mode";
import type { LockfileAssistant } from "@mycadet/local-mode/contract";
import { mockCommands } from "./commands-mock.js";

const entry: LockfileAssistant = {
  assistantId: "docker-backup",
  cloud: "docker",
  port: 7830,
};
const names = dockerResourceNames(entry.assistantId);
const containers = [
  names.assistantContainer,
  names.gatewayContainer,
  names.cesContainer,
];
const rootContainers = {
  workspace: names.assistantContainer,
  "gateway-security": names.gatewayContainer,
  "ces-security": names.cesContainer,
  "ces-data": names.cesContainer,
};
let directory: string;
let commands: ReturnType<typeof mockCommands>;
const running = new Map<string, boolean>();
let writes = 0;
let failWrite = 0;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "docker-root-mock-"));
  commands = mockCommands();
  writes = 0;
  failWrite = 0;
  for (const container of containers) running.set(container, true);
  for (const root of STATE_ROOTS) {
    await mkdir(join(directory, root), { mode: 0o700 });
    await writeFile(join(directory, root, "value"), "original", {
      mode: 0o600,
    });
  }
  await writeFile(
    join(directory, "gateway-security", "actor-token-signing-key"),
    Buffer.alloc(32, 1),
    { mode: 0o600 },
  );
  commands.on("docker", ["info"], {});
  commands.on(
    "docker",
    (args) => args[0] === "inspect",
    ({ args }) => {
      const container = args.at(-1)!;
      if (args.includes("--format"))
        return {
          stdout:
            args[2] === "{{.State.Running}}"
              ? String(running.get(container))
              : running.get(container)
                ? "running"
                : "exited",
        };
      return {
        stdout: JSON.stringify([
          {
            Image: "sha256:service-image",
            State: {
              Running: running.get(container),
              Status: running.get(container) ? "running" : "exited",
            },
            Config: {
              Env: ["RUNTIME_HTTP_PORT=3001", "GATEWAY_PORT=7830"],
              User: "1001:1001",
            },
            Mounts: STATE_ROOTS.filter(
              (root) => rootContainers[root] === container,
            ).map((root) => ({
              Type: "volume",
              Name: `remote-${root}`,
              Source: `/remote/${root}`,
              Destination: `/${root}`,
              RW: true,
            })),
          },
        ]),
      };
    },
  );
  commands.on(
    "docker",
    (args) => args[0] === "kill",
    ({ args }) => {
      expect(args[1]).toBe("--signal=SIGTERM");
      running.set(args.at(-1)!, false);
      return {};
    },
  );
  commands.on(
    "docker",
    (args) => args[0] === "start",
    ({ args }) => {
      running.set(args[1]!, true);
      return {};
    },
  );
  commands.on(
    "docker",
    (args) => args[0] === "cp",
    async ({ args }) => {
      const root = args[1]!.split(":/")[1]!.split("/")[0]!;
      await cp(join(directory, root), args[2]!, { recursive: true });
      return {};
    },
  );
  commands.on(
    "docker",
    (args) => args[0] === "run" && args.includes("-i"),
    async ({ args, input }) => {
      writes++;
      const mount = args[args.indexOf("--mount") + 1]!;
      const root = mount.split("src=remote-")[1]!.split(",")[0]!;
      expect(args).toContain("--network=none");
      expect(args).toContain("--user=0");
      expect(args).toContain("1001:1001");
      expect(mount).not.toContain(directory);
      expect(args[args.indexOf("-ec") + 1]).toContain('chown -R "$1" /restore');
      await rm(join(directory, root), { recursive: true });
      await mkdir(join(directory, root));
      if (writes === failWrite)
        return { code: 1, stderr: "injected volume replacement failure" };
      await pipeline(
        Readable.from(input),
        tar.x({ cwd: join(directory, root), preserveOwner: false }),
      );
      return {};
    },
  );
});
afterEach(async () => {
  commands.restore();
  await rm(directory, { recursive: true, force: true });
});

async function archive() {
  const capture = join(directory, "capture");
  await mkdir(capture);
  const storage = new DockerRootStorage(entry);
  await sleepDocker(entry, { timeoutMs: 100 });
  await storage.capture(capture);
  const file = join(directory, "backup.tar.gz");
  await packRoot(capture, file);
  return { storage, file };
}

test("Docker subprocess round-trip preserves every root, private files and clears stale entries", async () => {
  const { storage, file } = await archive();
  const stage = await stageRootArchive(file, directory);
  for (const root of STATE_ROOTS)
    await writeFile(join(directory, root, "stale"), "delete");
  await storage.replace(join(stage, "state"));
  for (const root of STATE_ROOTS) {
    expect(await readFile(join(directory, root, "value"), "utf8")).toBe(
      "original",
    );
    await expect(readFile(join(directory, root, "stale"))).rejects.toThrow();
  }
  expect(writes).toBe(4);
  expect(commands.calls.filter((call) => call.args[0] === "kill")).toHaveLength(
    3,
  );
});

test("failure during Docker replacement recovers prior roots before restarting", async () => {
  const { storage, file } = await archive();
  for (const container of containers) running.set(container, true);
  for (const root of STATE_ROOTS)
    await writeFile(join(directory, root, "value"), "destination");
  failWrite = 2;
  const recovery = join(directory, "recovery.tar.gz");
  await expect(
    restoreRootBackup(entry, file, { recoveryPath: recovery }),
  ).rejects.toThrow("injected volume replacement failure");
  expect(await storage.running()).toBe(true);
  const previous = await stageRootArchive(recovery, directory);
  for (const root of STATE_ROOTS) {
    expect(await readFile(join(directory, root, "value"), "utf8")).toBe(
      "destination",
    );
    expect(await readFile(join(previous, "state", root, "value"), "utf8")).toBe(
      "destination",
    );
  }
});

test("default Docker sleep aborts a graceful timeout without forcing termination", async () => {
  commands.on(
    "docker",
    (args) => args[0] === "kill",
    () => ({}),
  );
  await expect(sleepDocker(entry, { timeoutMs: 0 })).rejects.toThrow(
    "did not stop gracefully",
  );
  expect(running.get(names.assistantContainer)).toBe(true);
  expect(commands.calls.some((call) => call.args[0] === "stop")).toBe(false);
  expect(
    commands.calls
      .filter((call) => call.args[0] === "kill")
      .every((call) => call.args.includes("--signal=SIGTERM")),
  ).toBe(true);
});

test("create-only provisioning creates every target container without starting services", async () => {
  commands.on(
    "docker",
    (args) => args[0] === "create",
    ({ args }) => {
      running.set(args[args.indexOf("--name") + 1]!, false);
      return { stdout: "created" };
    },
  );
  await startContainers(
    {
      createOnly: true,
      gatewayPort: 7830,
      imageTags: {
        assistant: "assistant:target",
        gateway: "gateway:target",
        "credential-executor": "ces:target",
      },
      instanceName: entry.assistantId,
      res: names,
    },
    () => {},
  );
  const creates = commands.calls.filter((call) => call.args[0] === "create");
  expect(creates).toHaveLength(3);
  expect(creates.every((call) => !call.args.includes("-d"))).toBe(true);
  expect(
    commands.calls.some(
      (call) => call.args[0] === "start" || call.args[0] === "run",
    ),
  ).toBe(false);
  expect([...running.values()].every((value) => !value)).toBe(true);
});

test("packRoot skips symlinks the validator would reject and keeps safe relative links", async () => {
  // The bun store-link shapes a real workspace carries: absolute targets and
  // escaping relatives must not fail the pack; internal relative links stay.
  const nodeModules = join(directory, "workspace", "node_modules");
  await mkdir(nodeModules, { mode: 0o700 });
  await writeFile(join(nodeModules, "pkg"), "store", { mode: 0o600 });
  await symlink(
    "/usr/local/lib/node_modules/zod",
    join(nodeModules, "zod-abs"),
  );
  await symlink("../../../outside/zod", join(nodeModules, "zod-esc"));
  await symlink("./pkg", join(nodeModules, "zod-rel"));

  const warnings: string[] = [];
  const warn = spyOn(console, "warn").mockImplementation((...args) => {
    warnings.push(args.join(" "));
  });
  const file = join(directory, "backup.tar.gz");
  try {
    await packRoot(directory, file);
  } finally {
    warn.mockRestore();
  }

  expect(warnings.some((line) => line.includes("zod-abs"))).toBe(true);
  expect(warnings.some((line) => line.includes("zod-esc"))).toBe(true);
  expect(warnings.some((line) => line.includes("zod-rel"))).toBe(false);

  const paths: string[] = [];
  await tar.t({
    file,
    strict: true,
    onReadEntry: (entry) => {
      paths.push(entry.path);
    },
  });
  expect(paths.some((path) => path.endsWith("zod-rel"))).toBe(true);
  expect(paths.some((path) => path.includes("zod-abs"))).toBe(false);
  expect(paths.some((path) => path.includes("zod-esc"))).toBe(false);
});
