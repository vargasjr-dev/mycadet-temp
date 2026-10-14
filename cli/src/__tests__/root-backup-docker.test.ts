import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DockerRootStorage,
  restoreRootBackup,
  packRoot,
  stageRootArchive,
  STATE_ROOTS,
} from "../lib/root-backup.js";
import { dockerResourceNames, sleepContainers } from "../lib/docker.js";
import { execOutput } from "../lib/step-runner.js";
import type { AssistantEntry } from "../lib/assistant-config.js";

// Opt-in so the regular CLI suite never downloads images or touches a Docker daemon.
const image = process.env.CADET_BACKUP_TEST_IMAGE;
const name = `cadet-backup-test-${randomUUID()}`;
const res = dockerResourceNames(name);
const entry: AssistantEntry = {
  assistantId: name,
  cloud: "docker",
  runtimeUrl: "http://127.0.0.1:1",
};
let directory: string;
const mounts = new Map(STATE_ROOTS.map((root) => [root, `${name}-${root}`]));

beforeAll(async () => {
  if (!image) return;
  directory = await mkdtemp(join(tmpdir(), "docker-root-backup-"));
  for (const volume of mounts.values())
    await execOutput("docker", ["volume", "create", volume]);
  const groups = [
    { name: res.assistantContainer, roots: ["workspace"] },
    { name: res.gatewayContainer, roots: ["gateway-security"] },
    { name: res.cesContainer, roots: ["ces-security", "ces-data"] },
  ];
  for (const group of groups) {
    await execOutput("docker", [
      "run",
      "-d",
      "--name",
      group.name,
      "--network=none",
      "--user=1001:1001",
      ...group.roots.flatMap((root) => [
        "-v",
        `${mounts.get(root as (typeof STATE_ROOTS)[number])}:/${root}`,
      ]),
      image,
      "sh",
      "-c",
      "trap 'exit 0' TERM; while :; do sleep 1 & wait $!; done",
    ]);
  }
  for (const root of STATE_ROOTS) {
    await execOutput("docker", [
      "run",
      "--rm",
      "--network=none",
      "-v",
      `${mounts.get(root)}:/state`,
      image!,
      "sh",
      "-ec",
      'printf "original" > /state/value; chown -R 501:501 /state; chmod 600 /state/value',
    ]);
  }
  await execOutput("docker", [
    "run",
    "--rm",
    "--network=none",
    "-v",
    `${mounts.get("gateway-security")}:/state`,
    image!,
    "sh",
    "-ec",
    "dd if=/dev/zero of=/state/actor-token-signing-key bs=32 count=1; chmod 600 /state/actor-token-signing-key",
  ]);
});

afterAll(async () => {
  if (!image) return;
  for (const container of [
    res.cesContainer,
    res.gatewayContainer,
    res.assistantContainer,
  ]) {
    await execOutput("docker", ["rm", "-f", container]).catch(() => {});
  }
  for (const volume of mounts.values())
    await execOutput("docker", ["volume", "rm", volume]).catch(() => {});
  if (directory) await rm(directory, { recursive: true, force: true });
});

test.skipIf(!image)(
  "real Docker root round-trip restores mode-600 files as CES uid 1001 and clears stale entries",
  async () => {
    const storage = new DockerRootStorage(entry);
    expect(await storage.running()).toBe(true);
    await sleepContainers(res, { gracefulOnly: true, timeoutMs: 5000 });
    expect(await storage.running()).toBe(false);
    const stage = join(directory, "capture");
    await mkdir(stage, { mode: 0o700 });
    await storage.capture(stage);
    for (const root of STATE_ROOTS)
      expect(await readFile(join(stage, root, "value"), "utf8")).toBe(
        "original",
      );
    const file = join(directory, "backup.tar.gz");
    await packRoot(stage, file);
    const extracted = await stageRootArchive(file, directory);
    for (const root of STATE_ROOTS) {
      await execOutput("docker", [
        "run",
        "--rm",
        "--network=none",
        "-v",
        `${mounts.get(root)}:/state`,
        image!,
        "sh",
        "-ec",
        'printf "newer" > /state/value; touch /state/stale',
      ]);
    }
    await storage.replace(join(extracted, "state"));
    for (const root of STATE_ROOTS) {
      const output = await execOutput("docker", [
        "run",
        "--rm",
        "--network=none",
        "--user=1001:1001",
        "-v",
        `${mounts.get(root)}:/state:ro`,
        image!,
        "sh",
        "-ec",
        'cat /state/value; test ! -e /state/stale; stat -c "%u:%g %a" /state/value',
      ]);
      expect(output).toBe("original1001:1001 600");
    }
  },
);

test.skipIf(!image)(
  "real Docker replacement failure recovers prior roots and retains a recovery archive",
  async () => {
    for (const container of [
      res.assistantContainer,
      res.gatewayContainer,
      res.cesContainer,
    ])
      await execOutput("docker", ["start", container]);
    const storage = new DockerRootStorage(entry);
    const file = join(directory, "backup.tar.gz");
    for (const root of STATE_ROOTS) {
      await execOutput("docker", [
        "run",
        "--rm",
        "--network=none",
        "-v",
        `${mounts.get(root)}:/state`,
        image!,
        "sh",
        "-ec",
        'printf "destination" > /state/value',
      ]);
    }
    let attempts = 0;
    const recovery = join(directory, "recovery.tar.gz");
    await expect(
      restoreRootBackup(
        entry,
        file,
        { recoveryPath: recovery },
        {
          storage: {
            running: () => storage.running(),
            capture: (path) => storage.capture(path),
            prepareRestore: (path) => storage.prepareRestore(path),
            replace: async (path) => {
              attempts++;
              await storage.replace(path);
              if (attempts === 1)
                throw new Error("injected replacement failure");
            },
          },
          sleep: () =>
            sleepContainers(res, { gracefulOnly: true, timeoutMs: 5000 }),
          wake: async () => {
            for (const container of [
              res.assistantContainer,
              res.gatewayContainer,
              res.cesContainer,
            ])
              await execOutput("docker", ["start", container]);
          },
          save: () => {},
        },
      ),
    ).rejects.toThrow("injected replacement failure");
    expect(attempts).toBe(2);
    expect(await storage.running()).toBe(true);
    const previous = await stageRootArchive(recovery, directory);
    for (const root of STATE_ROOTS) {
      expect(
        await readFile(join(previous, "state", root, "value"), "utf8"),
      ).toBe("destination");
      const value = await execOutput("docker", [
        "run",
        "--rm",
        "--network=none",
        "--user=1001:1001",
        "-v",
        `${mounts.get(root)}:/state:ro`,
        image!,
        "cat",
        "/state/value",
      ]);
      expect(value).toBe("destination");
    }
  },
);
