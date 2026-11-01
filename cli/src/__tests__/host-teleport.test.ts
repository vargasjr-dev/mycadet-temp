import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLocalInstanceDir } from "../lib/remotes/local.js";
import type { LockfileAssistant } from "@mycadet/local-mode/contract";
import type { LocalAssistant } from "@mycadet/local-mode/contract";
import * as localMode from "@mycadet/local-mode";
import { saveLockfileAssistant } from "@mycadet/local-mode";
import {
  storageFor,
  teleportHostInstallation,
  TeleportRecoveryError,
  type HostTeleportOps,
} from "../lib/host-teleport.js";
import {
  createRootBackup,
  LocalRootStorage,
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
// The teleport flow calls sleepAssistant directly now (the ops seam is
// gone), so the sleep events ride a namespace spy.
const sleepMock = spyOn(localMode, "sleepAssistant");

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "host-teleport-"));
  process.env.XDG_DATA_HOME = directory;
  previousLockDir = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = join(directory, "registry");
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
  sleepMock.mockImplementation(async (entry) => {
    order.push(`sleep:${entry.assistantId}`);
    running.set(entry.assistantId, false);
    return {
      ok: true,
      kind: "services",
      services: { assistant: "stopped", gateway: "stopped", ces: "stopped" },
      notes: [],
    } as never;
  });
  // Simulated service state rides the storage prototype: the backup/restore
  // fns construct their own LocalRootStorage now, so the liveness override
  // has to reach them all.
  spyOn(LocalRootStorage.prototype, "running").mockImplementation(
    async function (this: LocalRootStorage) {
      return running.get(this.entry.assistantId) ?? false;
    },
  );
  spyOn(LocalRootStorage.prototype, "resume").mockImplementation(
    async function (this: LocalRootStorage) {
      order.push(`wake:${this.entry.assistantId}`);
      running.set(this.entry.assistantId, true);
    },
  );
  ops = {
    storage: (entry) => storageFor(entry),
    backup: mock(async (entry) => {
      const file = join(directory, `${entry.assistantId}.tar.gz`);
      await createRootBackup({ ...entry, cloud: "local" }, file);
      order.push(`backup:${entry.assistantId}`);
      return file;
    }),
    version: mock(async () => "0.12.9"),
    hatch: mock(async () => target),
    restore: mock(async (entry, archive) => {
      await restoreRootBackup({ ...entry, cloud: "local" }, archive, {
        resume: false,
        recoveryPath: join(directory, "pre-restore.tar.gz"),
      });
      await storageFor(entry).resume();
      order.push(`restore:${entry.assistantId}`);
    }),
    retire: mock(async (entry) => {
      order.push(`retire:${entry.assistantId}`);
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
  expect(order).toEqual([
    "sleep:source",
    "backup:source",
    "sleep:target",
    "backup:target",
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
  expect(ops.version).not.toHaveBeenCalled();
  expect(ops.backup).not.toHaveBeenCalled();
  expect(ops.hatch).not.toHaveBeenCalled();
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
  expect(ops.retire).not.toHaveBeenCalled();
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
  expect(ops.retire).not.toHaveBeenCalled();
});
test("graceful shutdown failure never captures a live installation", async () => {
  sleepMock.mockImplementation(
    async () =>
      ({ ok: false, status: 500, error: "graceful timeout" }) as never,
  );
  await expect(
    teleportHostInstallation(source, "local", "target", options, ops),
  ).rejects.toThrow("Source services are still running; teleport aborted.");
  await expect(
    teleportHostInstallation(source, "local", "target", options, ops),
  ).rejects.toThrow("Source services are still running; teleport aborted.");
  expect(ops.backup).not.toHaveBeenCalled();
  expect(ops.retire).not.toHaveBeenCalled();
});
test("source that fails to stop is rejected even if sleep returned", async () => {
  // The sleep operation reports success without actually stopping anything —
  // the flow's own stopped-check must still reject the capture.
  sleepMock.mockImplementation(
    async () => ({ ok: true, kind: "containers" }) as never,
  );
  await expect(
    teleportHostInstallation(source, "local", "target", options, ops),
  ).rejects.toThrow("still running");
  expect(ops.backup).not.toHaveBeenCalled();
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
  expect(ops.retire).not.toHaveBeenCalled();
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
  expect(ops.retire).not.toHaveBeenCalled();
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
test("new target receives safety tar at hatch and becomes ready before source retirement", async () => {
  await teleportHostInstallation(source, "local", "fresh-target", options, ops);
  expect(ops.hatch).toHaveBeenCalledWith(
    "local",
    "fresh-target",
    join(directory, "source.tar.gz"),
  );
  expect(order.indexOf("wake:target")).toBeLessThan(
    order.indexOf("retire:source"),
  );
  expect(ops.restore).not.toHaveBeenCalled();
});
test("failed new target readiness cleans it up before waking source", async () => {
  const resume = spyOn(LocalRootStorage.prototype, "resume");
  resume.mockImplementation(async function (this: LocalRootStorage) {
    if (this.entry.assistantId === "target") {
      throw new Error("migration failed");
    }
    order.push(`wake:${this.entry.assistantId}`);
    running.set(this.entry.assistantId, true);
  });
  await expect(
    teleportHostInstallation(source, "local", "fresh-target", options, ops),
  ).rejects.toThrow("migration failed");
  expect(order.slice(-3)).toEqual([
    "sleep:target",
    "retire:target",
    "wake:source",
  ]);
  expect(order).not.toContain("retire:source");
});
test("hatch failure retains tar and wakes source", async () => {
  ops.hatch = mock(async () => {
    throw new Error("image pull failed");
  });
  await expect(
    teleportHostInstallation(source, "local", "fresh-target", options, ops),
  ).rejects.toThrow("image pull failed");
  expect(order.at(-1)).toBe("wake:source");
  expect(await readFile(join(directory, "source.tar.gz"))).not.toHaveLength(0);
  expect(ops.retire).not.toHaveBeenCalled();
});
test("multi-patch downgrade fails before shutdown", async () => {
  ops.version = mock(async (entry) => (entry === source ? "0.12.9" : "0.12.5"));
  await expect(
    teleportHostInstallation(source, "local", "target", options, ops),
  ).rejects.toThrow("older than source");
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
  expect(ops.retire).not.toHaveBeenCalled();
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
