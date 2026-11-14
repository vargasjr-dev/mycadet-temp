import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import * as execModule from "../exec";
import * as hatch from "../remotes/docker/hatch";
import * as rootBackup from "../root-backup";
import * as lockfile from "../lockfile";
import * as lookup from "../operations/lookup";
import * as hatchLock from "../remotes/local/hatch-lock";
import * as localHatch from "../remotes/local/hatch";
import { initializeDockerTeleportTarget } from "../remotes/docker/teleport";
import { initializeLocalTeleportTarget } from "../remotes/local/teleport";

const ensureInstalled = spyOn(
  hatch,
  "ensureDockerInstalled",
).mockResolvedValue();
const pullImageSpy = spyOn(hatch, "pullImage").mockResolvedValue();
// `inspect` answers like a missing resource so the idempotent creates run.
const execSpy = spyOn(execModule, "exec").mockImplementation(
  async (_cmd: string, args: string[]) => {
    if (args?.[1] === "inspect") {
      throw new Error("No such object");
    }
    return { stdout: "", stderr: "" } as never;
  },
);
const dockerArchive = spyOn(
  rootBackup,
  "initializeRootArchive",
).mockResolvedValue();
const saveEntry = spyOn(lockfile, "saveLockfileAssistant").mockImplementation(
  (() => {}) as never,
);
beforeEach(() => {
  for (const spy of [dockerArchive, saveEntry]) {
    // The call-order assertions need clean records; the mocks stay bound.
    spy.mockClear();
  }
  execSpy.mockClear();
});
afterAll(() => {
  for (const spy of [
    ensureInstalled,
    pullImageSpy,
    execSpy,
    dockerArchive,
    saveEntry,
  ]) {
    spy.mockRestore();
  }
});

test("a fresh docker target initializes the volumes without creating containers", async () => {
  const entry = await initializeDockerTeleportTarget(
    "fresh-docker",
    "/backups/source-pre-teleport.tar.gz",
  );

  expect(entry.assistantId).toBe("fresh-docker");
  expect(entry.cloud).toBe("docker");
  const images = (entry as { containerInfo?: { assistantImage: string } })
    .containerInfo;
  expect(images?.assistantImage).toContain("assistant");
  expect(entry.hatchedAt).toBeDefined();

  const dockerArgs = execSpy.mock.calls.map((call) => call[1] as string[]);
  // The network and every volume are created idempotently...
  expect(dockerArgs.some((args) => args?.includes("network"))).toBe(true);
  expect(
    dockerArgs.filter((args) => args?.[0] === "volume" && args[1] === "create")
      .length,
  ).toBeGreaterThanOrEqual(6);
  // ...and the only `docker run` is the ownership chown — no service
  // container is ever created; the wake's recreate builds those.
  const runs = dockerArgs.filter((args) => args?.[0] === "run");
  expect(runs.length).toBe(1);
  expect(runs[0]).toContain("busybox");

  // The install happens before the entry persists: a failed install never
  // registers a half-initialized assistant.
  expect(dockerArchive).toHaveBeenCalledTimes(1);
  expect(saveEntry).toHaveBeenCalledTimes(1);
  expect(
    dockerArchive.mock.invocationCallOrder[0] <
      saveEntry.mock.invocationCallOrder[0],
  ).toBe(true);
});

test("a fresh local target installs the archive, then persists", async () => {
  const withLock = spyOn(hatchLock, "withLocalHatchLock").mockImplementation(
    async (action) => action(),
  );
  const placement = spyOn(
    localHatch,
    "allocateLocalPlacement",
  ).mockResolvedValue({
    instanceDir: "/instances/fresh-local",
    port: 7830,
    daemonPort: 7831,
    cesPort: 7832,
  } as never);
  let saved: { assistantId: string; hatchedAt?: string } | undefined;
  const findEntry = spyOn(lookup, "findAssistantByName").mockImplementation(
    () => (saved ?? null) as never,
  );
  const localArchive = spyOn(
    rootBackup,
    "initializeRootArchive",
  ).mockResolvedValue();
  const localSave = spyOn(lockfile, "saveLockfileAssistant").mockImplementation(
    ((e: { assistantId: string; hatchedAt?: string }) => {
      saved = e;
    }) as never,
  );

  try {
    const result = await initializeLocalTeleportTarget(
      "fresh-local",
      "/backups/source-pre-teleport.tar.gz",
    );

    expect(result.assistantId).toBe("fresh-local");
    expect(result.hatchedAt).toBeDefined();
    expect(withLock).toHaveBeenCalledTimes(1);
    expect(localArchive).toHaveBeenCalledWith(
      expect.objectContaining({ assistantId: "fresh-local" }),
      "/backups/source-pre-teleport.tar.gz",
    );
    // Same order as the docker arm: data lands before the registration.
    expect(
      localArchive.mock.invocationCallOrder[0] <
        localSave.mock.invocationCallOrder[0],
    ).toBe(true);
  } finally {
    for (const spy of [
      withLock,
      placement,
      findEntry,
      localArchive,
      localSave,
    ]) {
      spy.mockRestore();
    }
  }
});
