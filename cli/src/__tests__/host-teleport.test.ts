import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLocalInstanceDir } from "@mycadet/local-mode";
import type { LockfileAssistant } from "@mycadet/local-mode/contract";
import type { LocalAssistant } from "@mycadet/local-mode/contract";
import * as localMode from "@mycadet/local-mode";
import { saveLockfileAssistant } from "@mycadet/local-mode";
import {
  teleportHostInstallation,
  TeleportRecoveryError,
  type HostTeleportOps,
} from "../lib/host-teleport.js";
import {
  createRootBackup,
  restoreRootBackup,
  STATE_ROOTS,
} from "../lib/root-backup.js";

let directory: string,
  source: LockfileAssistant,
  target: LocalAssistant,
  ops: HostTeleportOps;
let order: string[], running: Map<string, boolean>;
let log: ReturnType<typeof spyOn>, previousLockDir: string | undefined;
const options = { dryRun: false, keepSource: false };
async function instance(
  name: string,
  cloud: "local" | "docker",
  byte: number,
): Promise<LockfileAssistant> {
  const root = join(directory, name);
  for (const state of STATE_ROOTS) {
    await mkdir(join(root, state), { recursive: true });
    await writeFile(join(root, state, "state"), `${name}:${state}`, {
      mode: 0o600,
    });
  }
  await writeFile(
    join(root, "gateway-security", "actor-token-signing-key"),
    Buffer.alloc(32, byte),
  );
  await writeFile(
    join(root, "ces-security", "keys.enc"),
    Buffer.from([byte, 0, 255]),
  );
  await writeFile(
    join(root, "ces-security", "store.key"),
    Buffer.alloc(32, byte + 1),
  );
  return {
    assistantId: name,
    cloud,
    instanceDir: root,
    daemonPort: 1,
    port: 2,
    cesPort: 3,
  };
}
const previousDataHome = process.env.XDG_DATA_HOME;
// Re-created per test (and restored per afterEach) so the co-run suites
// see the real operations — the namespace spies patch the shared module
// registry, so anything they leave attached leaks across files.
let sleepMock: ReturnType<typeof spyOn<typeof localMode, "sleepAssistant">>;
// Liveness rides the one health method: the flow's wake-recovery decisions
// ask whether the gateway answers, so the override models the running map.
let healthMock: ReturnType<typeof spyOn<typeof localMode, "checkHealth">>;
// Same for wake: the flow calls the package's wakeAssistant (the one
// revive seam), so the wake events ride a namespace spy like sleep.
// Re-created per test (and restored per afterEach) so the co-run suites
// see the real operation.
let wakeMock: ReturnType<typeof spyOn<typeof localMode, "wakeAssistant">>;
let retireMock: ReturnType<typeof spyOn<typeof localMode, "retireAssistant">>;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "host-teleport-"));
  process.env.XDG_DATA_HOME = directory;
  previousLockDir = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(directory, "registry");
  sleepMock = spyOn(localMode, "sleepAssistant");
  healthMock = spyOn(localMode, "checkHealth");
  source = await instance("source", "local", 7);
  target = (await instance("target", "local", 3)) as LocalAssistant;
  saveLockfileAssistant(source);
  saveLockfileAssistant(target);
  order = [];
  running = new Map([
    ["source", true],
    ["target", true],
  ]);
  log = spyOn(console, "log").mockImplementation(() => {});
  wakeMock = spyOn(localMode, "wakeAssistant");
  retireMock = spyOn(localMode, "retireAssistant");
  retireMock.mockImplementation(async (entry) => {
    order.push(`retire:${entry.assistantId}`);
    return { ok: true as const };
  });
  sleepMock.mockImplementation(async (entry) => {
    order.push(`sleep:${entry.assistantId}`);
    // The report models the pre-sleep state: only services the sleep
    // actually stopped come back "stopped" (the backup lifecycle the
    // teleport drives derives its restart signal from this).
    const wasRunning = running.get(entry.assistantId) ?? false;
    running.set(entry.assistantId, false);
    return {
      ok: true,
      kind: "services",
      services: {
        assistant: wasRunning ? "stopped" : "not-running",
        gateway: wasRunning ? "stopped" : "not-running",
        ces: wasRunning ? "stopped" : "not-running",
      },
      notes: [],
    } as never;
  });
  // Liveness rides the health check's entry probe: the flow's wake-recovery
  // decisions ask whether the gateway answers, so the override models the
  // running map through the served version.
  healthMock.mockImplementation(async (entry: LockfileAssistant) =>
    running.get(entry.assistantId)
      ? { version: "1.0.0", status: "healthy", authenticated: true }
      : { authenticated: true },
  );
  wakeMock.mockImplementation(async (entry) => {
    order.push(`wake:${entry.assistantId}`);
    running.set(entry.assistantId, true);
    return { ok: true as const };
  });
  ops = {
    backup: mock(async (entry) => {
      const file = join(directory, `${entry.assistantId}.tar.gz`);
      await createRootBackup({ ...entry, cloud: "local" }, file);
      order.push(`backup:${entry.assistantId}`);
      return file;
    }),
    restore: mock(async (entry, archive) => {
      await restoreRootBackup({ ...entry, cloud: "local" }, archive, {
        resume: false,
        recoveryPath: join(directory, "pre-restore.tar.gz"),
      });
      await wakeMock(entry);
      order.push(`restore:${entry.assistantId}`);
    }),
  };
});
afterEach(async () => {
  if (previousDataHome === undefined) {
    delete process.env.XDG_DATA_HOME;
  } else {
    process.env.XDG_DATA_HOME = previousDataHome;
  }
  log.mockRestore();
  // The namespace spies must not leak into the other suites that share
  // this process.
  sleepMock.mockRestore();
  healthMock.mockRestore();
  wakeMock.mockRestore();
  retireMock.mockRestore();
  if (previousLockDir === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = previousLockDir;
  }
  await rm(directory, { recursive: true, force: true });
});

test("moves all four roots and encrypted key pairs using the exact stopped-source safety tar", async () => {
  await teleportHostInstallation(source, "local", "target", options, ops);
  for (const state of STATE_ROOTS) {
    expect(
      await readFile(join(getLocalInstanceDir(target), state, "state"), "utf8"),
    ).toBe(`source:${state}`);
  }
  expect(
    await readFile(
      join(getLocalInstanceDir(target), "ces-security", "keys.enc"),
    ),
  ).toEqual(Buffer.from([7, 0, 255]));
  expect(
    await readFile(
      join(getLocalInstanceDir(target), "ces-security", "store.key"),
    ),
  ).toEqual(Buffer.alloc(32, 8));
  // The backup and restore lifecycles sleep unconditionally now (the sleep
  // is idempotent), so the flow's own sleeps are joined by the lifecycle's.
  expect(order).toEqual([
    "sleep:source",
    "sleep:source",
    "backup:source",
    "sleep:target",
    "sleep:target",
    "backup:target",
    "sleep:target",
    "wake:target",
    "restore:target",
    "retire:source",
  ]);
  expect(ops.restore).toHaveBeenCalledWith(
    expect.objectContaining({ assistantId: "target" }),
    join(directory, "source.tar.gz"),
    join(directory, "target.tar.gz"),
  );
});
test("dry run creates no archives and does not stop or hatch services", async () => {
  await teleportHostInstallation(
    source,
    "local",
    "target",
    { ...options, dryRun: true },
    ops,
  );
  expect(order).toEqual([]);
  expect(ops.backup).not.toHaveBeenCalled();
});
test("keep-source retains the stopped original", async () => {
  await teleportHostInstallation(
    source,
    "local",
    "target",
    { ...options, keepSource: true },
    ops,
  );
  expect(running.get("source")).toBe(false);
  expect(retireMock).not.toHaveBeenCalled();
});
test("source backup failure wakes source without touching target", async () => {
  ops.backup = mock(async () => {
    throw new Error("unreadable credential store");
  });
  await expect(
    teleportHostInstallation(source, "local", "target", options, ops),
  ).rejects.toThrow("unreadable credential store");
  expect(order).toEqual(["sleep:source", "wake:source"]);
  expect(ops.restore).not.toHaveBeenCalled();
  expect(retireMock).not.toHaveBeenCalled();
});
test("a failed graceful shutdown aborts with sleep's own error", async () => {
  // The flow trusts the sleep operation: a failure surfaces the operation's
  // structured error — there is no separate post-sleep liveness check to
  // second-guess it.
  sleepMock.mockImplementation(
    async () =>
      ({ ok: false, status: 500, error: "graceful timeout" }) as never,
  );
  await expect(
    teleportHostInstallation(source, "local", "target", options, ops),
  ).rejects.toThrow("graceful timeout");
  await expect(
    teleportHostInstallation(source, "local", "target", options, ops),
  ).rejects.toThrow("graceful timeout");
  expect(ops.backup).not.toHaveBeenCalled();
  expect(retireMock).not.toHaveBeenCalled();
});
test("target capture failure resumes both original installations", async () => {
  const backup = ops.backup;
  ops.backup = mock(async (entry) => {
    if (entry.assistantId === target.assistantId) {
      throw new Error("target capture failed");
    }
    return backup(entry);
  });
  await expect(
    teleportHostInstallation(source, "local", "target", options, ops),
  ).rejects.toThrow("target capture failed");
  expect(order.slice(-2)).toEqual(["wake:target", "wake:source"]);
  expect(ops.restore).not.toHaveBeenCalled();
});
test("failed import retains source and resumes recovered target", async () => {
  ops.restore = mock(async () => {
    throw new Error("import failed; original data recovered");
  });
  await expect(
    teleportHostInstallation(source, "local", "target", options, ops),
  ).rejects.toThrow("import failed");
  expect(retireMock).not.toHaveBeenCalled();
  expect(order.slice(-2)).toEqual(["wake:target", "wake:source"]);
});
test("failed recovery leaves damaged target stopped", async () => {
  ops.restore = mock(async () => {
    throw new TeleportRecoveryError([], "recovery failed");
  });
  await expect(
    teleportHostInstallation(source, "local", "target", options, ops),
  ).rejects.toThrow("recovery failed");
  expect(running.get("target")).toBe(false);
  expect(order).not.toContain("wake:target");
  expect(retireMock).not.toHaveBeenCalled();
});
test("originally sleeping source stays asleep on capture failure", async () => {
  running.set("source", false);
  ops.backup = mock(async () => {
    throw new Error("capture failed");
  });
  await expect(
    teleportHostInstallation(source, "local", "target", options, ops),
  ).rejects.toThrow("capture failed");
  expect(order).not.toContain("wake:source");
});
test("new target receives safety tar at init and becomes ready before source retirement", async () => {
  await teleportHostInstallation(source, "local", "fresh-target", options, ops);
  // The archive landed in the fresh target's roots before the wake — the
  // init installed it, the wake spy saw the target first, retirement after.
  const allocated = (
    localMode
      .loadAllAssistants()
      .find((e) => e.assistantId === "fresh-target") as LocalAssistant
  ).instanceDir;
  const state = await readFile(
    join(allocated ?? "", "workspace", "state"),
    "utf-8",
  );
  expect(state).toBe("source:workspace");
  expect(order.indexOf("wake:target")).toBeLessThan(
    order.indexOf("retire:source"),
  );
  expect(ops.restore).not.toHaveBeenCalled();
});
test("failed new target readiness cleans it up before waking source", async () => {
  // The flow owns the wake now: the target's wake failing IS the failed
  // readiness — no ops.hatch seam to short-circuit through.
  wakeMock.mockImplementation(async (entry) => {
    if (entry.assistantId === "fresh-target") {
      throw new Error("migration failed");
    }
    order.push(`wake:${entry.assistantId}`);
    running.set(entry.assistantId, true);
    return { ok: true as const };
  });
  await expect(
    teleportHostInstallation(source, "local", "fresh-target", options, ops),
  ).rejects.toThrow("migration failed");
  expect(order.slice(-3)).toEqual([
    "sleep:fresh-target",
    "retire:fresh-target",
    "wake:source",
  ]);
  expect(order).not.toContain("retire:source");
});
test("init failure retains tar and wakes source", async () => {
  // The archive install throws before the entry is persisted, so the
  // transferred archive survives on disk for the retry and the source wakes.
  const bad = join(directory, "garbage.tar.gz");
  await writeFile(bad, "not a tar");
  const backup = ops.backup;
  ops.backup = mock(async () => bad);
  try {
    await expect(
      teleportHostInstallation(source, "local", "fresh-target", options, ops),
    ).rejects.toThrow();
    expect(order.at(-1)).toBe("wake:source");
    expect((await readFile(bad)).length).toBeGreaterThan(0);
    expect(retireMock).not.toHaveBeenCalled();
  } finally {
    ops.backup = backup;
  }
});
test("multi-patch downgrade fails before shutdown", async () => {
  // The version check calls the package's fetchCurrentVersion directly (the
  // ops.version seam is gone). First call = the source's runtime, second =
  // the existing target's, so the downgrade guard sees an older target.
  const versionMock = spyOn(localMode, "fetchCurrentVersion");
  versionMock.mockResolvedValueOnce("0.12.9").mockResolvedValueOnce("0.12.5");
  try {
    await expect(
      teleportHostInstallation(source, "local", "target", options, ops),
    ).rejects.toThrow("older than source");
  } finally {
    versionMock.mockRestore();
  }
  expect(order).toEqual([]);
});
test("target environment mismatch fails before shutdown", async () => {
  await expect(
    teleportHostInstallation(source, "docker", "target", options, ops),
  ).rejects.toThrow("not docker");
  expect(order).toEqual([]);
});
test("source restarted during transfer is retained to preserve newer writes", async () => {
  const restore = ops.restore;
  ops.restore = mock(async (entry, archive, recovery) => {
    await restore(entry, archive, recovery);
    running.set("source", true);
  });
  await expect(
    teleportHostInstallation(source, "local", "target", options, ops),
  ).rejects.toThrow("restarted during teleport");
  expect(retireMock).not.toHaveBeenCalled();
  expect(order).not.toContain("wake:source");
});

test("holds source and target operation locks through import and releases them afterward", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const importing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const restore = ops.restore;
  ops.restore = mock(async (entry, archive, recovery) => {
    entered();
    await blocked;
    await restore(entry, archive, recovery);
  });
  const transfer = teleportHostInstallation(
    source,
    "local",
    "target",
    options,
    ops,
  );
  await importing;
  try {
    for (const entry of [source, target]) {
      await expect(
        createRootBackup(entry, join(directory, "competing.tar.gz")),
      ).rejects.toThrow("Another backup/restore owns");
    }
  } finally {
    release();
  }
  await transfer;
  await createRootBackup(source, join(directory, "after.tar.gz"));
});
