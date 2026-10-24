import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tar from "tar";
import type { LockfileAssistant } from "../lib/assistant-config.js";
import {
  createRootBackup,
  initializeRootArchive,
  DockerRootStorage,
  LocalRootStorage,
  packRoot,
  restoreRootBackup,
  stageRootArchive,
  STATE_ROOTS,
  validateRootArchive,
  type RootBackupOps,
} from "../lib/root-backup.js";

const scratch: string[] = [];
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "root-backup-test-"));
  scratch.push(dir);
  const root = join(dir, "instance");
  for (const name of STATE_ROOTS)
    await mkdir(join(root, name), { recursive: true, mode: 0o700 });
  await mkdir(join(root, "workspace", "data", "db"), { recursive: true });
  await writeFile(join(root, "workspace", "notes.md"), "source notes");
  await writeFile(join(root, "workspace", "cadet.pid"), "99999999");
  await mkdir(join(root, "workspace", "signals"));
  await writeFile(join(root, "workspace", "signals", "old"), "transient");
  await writeFile(
    join(root, "gateway-security", "guardian-init.lock"),
    "persistent lock",
  );
  await writeFile(
    join(root, "gateway-security", "actor-token-signing-key"),
    Buffer.alloc(32, 7),
    { mode: 0o600 },
  );
  // Deliberately not valid credential JSON: capture must not decode/decrypt it.
  await writeFile(
    join(root, "ces-security", "keys.enc"),
    "opaque encrypted bytes",
    { mode: 0o600 },
  );
  await writeFile(
    join(root, "ces-security", "store.key"),
    Buffer.alloc(32, 3),
    { mode: 0o600 },
  );
  await writeFile(join(root, "ces-data", "grants.json"), "CES policies");
  await symlink("notes.md", join(root, "workspace", "notes-link"));
  const entry: LockfileAssistant = {
    assistantId: "test",
    cloud: "local",
    runtimeUrl: "http://127.0.0.1:7831",
    resources: {
      instanceDir: root,
      daemonPort: 7821,
      gatewayPort: 7831,
      cesPort: 7790,
      signingKey: "07".repeat(32),
    },
  };
  return { dir, root, entry, file: join(dir, "backup.tar.gz") };
}
afterEach(async () => {
  for (const dir of scratch.splice(0))
    await rm(dir, { recursive: true, force: true });
});

describe("root tar backup", () => {
  test("initializes a fresh stopped instance with complete roots and the archived signing key", async () => {
    const { root, entry, file, dir } = await fixture();
    await packRoot(root, file);
    const destination = join(dir, "fresh-instance");
    await mkdir(destination);
    const fresh = {
      ...entry,
      resources: { ...entry.resources!, instanceDir: destination },
    };
    const key = await initializeRootArchive(fresh, file);
    expect(key).toBe("07".repeat(32));
    expect(
      await readFile(join(destination, "ces-security", "keys.enc"), "utf8"),
    ).toBe("opaque encrypted bytes");
    expect(
      await readFile(join(destination, "ces-security", "store.key")),
    ).toEqual(Buffer.alloc(32, 3));
    expect(
      await readFile(join(destination, "ces-data", "grants.json"), "utf8"),
    ).toBe("CES policies");
    expect(await readdir(destination)).toEqual([...STATE_ROOTS].sort());
  });

  test("initialization refuses running services before replacing any roots", async () => {
    const { root, entry, file } = await fixture();
    await packRoot(root, file);
    const storage = new LocalRootStorage(entry);
    storage.running = async () => true;
    await expect(initializeRootArchive(entry, file, storage)).rejects.toThrow(
      "still running",
    );
    expect(await readFile(join(root, "workspace", "notes.md"), "utf8")).toBe(
      "source notes",
    );
  });

  test("round-trips every service root, encrypted bytes, permissions and internal links", async () => {
    const { root, entry, file, dir } = await fixture();
    await createRootBackup(entry, file);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const staged = await stageRootArchive(file, dir);
    const restored = join(staged, "state");
    expect(
      await readFile(join(restored, "ces-security", "keys.enc"), "utf8"),
    ).toBe("opaque encrypted bytes");
    expect(
      await readFile(join(restored, "ces-data", "grants.json"), "utf8"),
    ).toBe("CES policies");
    expect(
      await readFile(
        join(restored, "gateway-security", "guardian-init.lock"),
        "utf8",
      ),
    ).toBe("persistent lock");
    expect(
      await readFile(join(restored, "workspace", "notes-link"), "utf8"),
    ).toBe("source notes");
    expect(
      (await lstat(join(restored, "workspace", "notes-link"))).isSymbolicLink(),
    ).toBe(true);
    expect(
      (await stat(join(restored, "ces-security", "store.key"))).mode & 0o777,
    ).toBe(0o600);
    expect(await readdir(join(restored, "workspace"))).not.toContain(
      "cadet.pid",
    );
    expect(await readdir(join(restored, "workspace"))).not.toContain("signals");
    expect(await readFile(join(root, "workspace", "notes.md"), "utf8")).toBe(
      "source notes",
    );
  });

  test("captures committed SQLite WAL frames without opening or checkpointing the live DB", async () => {
    const { entry, root, file, dir } = await fixture();
    const db = new Database(
      join(root, "workspace", "data", "db", "assistant.db"),
    );
    db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE notes (text); INSERT INTO notes VALUES ('committed WAL');",
    );
    try {
      await createRootBackup(entry, file);
      const staged = await stageRootArchive(file, dir);
      const copy = new Database(
        join(staged, "state", "workspace", "data", "db", "assistant.db"),
      );
      try {
        expect(copy.query("SELECT text FROM notes").get()).toEqual({
          text: "committed WAL",
        });
      } finally {
        copy.close();
      }
    } finally {
      db.close();
    }
  });

  test("resumes services before compression, but never captures after failed graceful shutdown", async () => {
    const { entry, file, root } = await fixture();
    let running = true;
    const events: string[] = [];
    const storage = new LocalRootStorage(entry);
    const ops: RootBackupOps = {
      storage: {
        running: async () => running,
        capture: async (path) => {
          events.push("capture");
          expect(running).toBe(false);
          await storage.capture(path);
        },
        replace: (path) => storage.replace(path),
      },
      sleep: async () => {
        events.push("sleep");
        running = false;
      },
      wake: async () => {
        events.push("wake");
        running = true;
        expect(
          await readFile(join(root, "workspace", "notes.md"), "utf8"),
        ).toBe("source notes");
      },
      save: () => {},
    };
    await createRootBackup(entry, file, ops);
    expect(events).toEqual(["sleep", "capture", "wake"]);
    events.length = 0;
    ops.sleep = async () => {
      events.push("sleep");
      throw new Error("refused shutdown");
    };
    await expect(createRootBackup(entry, file, ops)).rejects.toThrow(
      "refused shutdown",
    );
    expect(events).toEqual(["sleep", "wake"]);
  });

  test("restore replaces stale state and retains a restorable recovery archive", async () => {
    const { entry, root, file, dir } = await fixture();
    await createRootBackup(entry, file);
    await writeFile(join(root, "workspace", "notes.md"), "newer destination");
    await writeFile(join(root, "ces-data", "stale.json"), "remove me");
    const recovery = join(dir, "recovery.tar.gz");
    const storage = new LocalRootStorage(entry);
    const ops: RootBackupOps = {
      storage,
      sleep: async () => {
        throw new Error("already stopped");
      },
      wake: async () => {
        throw new Error("must stay stopped");
      },
      save: () => {},
    };
    expect(
      await restoreRootBackup(entry, file, { recoveryPath: recovery }, ops),
    ).toBe(recovery);
    expect(await readFile(join(root, "workspace", "notes.md"), "utf8")).toBe(
      "source notes",
    );
    expect(await readdir(join(root, "ces-data"))).not.toContain("stale.json");
    const previous = await stageRootArchive(recovery, dir);
    expect(
      await readFile(join(previous, "state", "workspace", "notes.md"), "utf8"),
    ).toBe("newer destination");
  });

  test("dry-run leaves services and destination untouched", async () => {
    const { entry, file, root } = await fixture();
    await createRootBackup(entry, file);
    await writeFile(join(root, "workspace", "notes.md"), "destination");
    const ops: RootBackupOps = {
      storage: new LocalRootStorage(entry),
      sleep: async () => {
        throw new Error("must not stop");
      },
      wake: async () => {},
      save: () => {
        throw new Error("must not save");
      },
    };
    await restoreRootBackup(entry, file, { dryRun: true }, ops);
    expect(await readFile(join(root, "workspace", "notes.md"), "utf8")).toBe(
      "destination",
    );
  });

  test("a failed replacement recovers every service root before resuming", async () => {
    const { entry, file, root, dir } = await fixture();
    await createRootBackup(entry, file);
    await writeFile(join(root, "workspace", "notes.md"), "destination");
    const storage = new LocalRootStorage(entry);
    let attempts = 0,
      running = true;
    const ops: RootBackupOps = {
      storage: {
        running: async () => running,
        capture: (path) => storage.capture(path),
        replace: async (path) => {
          attempts++;
          await storage.replace(path);
          if (attempts === 1) throw new Error("partial restore failure");
        },
      },
      sleep: async () => {
        running = false;
      },
      wake: async () => {
        running = true;
      },
      save: () => {},
    };
    await expect(
      restoreRootBackup(
        entry,
        file,
        { recoveryPath: join(dir, "recovery.tar.gz") },
        ops,
      ),
    ).rejects.toThrow("partial restore failure");
    expect(attempts).toBe(2);
    expect(running).toBe(true);
    expect(await readFile(join(root, "workspace", "notes.md"), "utf8")).toBe(
      "destination",
    );
  });

  test("rejects traversal, unsafe links, missing roots, legacy bundles and truncated gzip before stopping", async () => {
    const { root, file, dir } = await fixture();
    await symlink("../../escape", join(root, "workspace", "escape"));
    await tar.c({ cwd: root, file, gzip: true }, [...STATE_ROOTS]);
    await expect(validateRootArchive(file)).rejects.toThrow(
      "Invalid root archive path",
    );
    await rm(join(root, "workspace", "escape"));
    await tar.c({ cwd: root, file, gzip: true }, ["workspace"]);
    await expect(validateRootArchive(file)).rejects.toThrow(
      "missing state root",
    );
    await packRoot(root, file);
    const compressed = await readFile(file);
    await writeFile(file, compressed.subarray(0, compressed.length - 70));
    await expect(stageRootArchive(file, dir)).rejects.toThrow();
    await expect(
      stageRootArchive(join(dir, "legacy.vbundle"), dir),
    ).rejects.toThrow("vellum-to-cadet");
  });

  test.skipIf(process.platform === "win32")(
    "unreadable credential files fail capture without publishing an incomplete archive",
    async () => {
      const { entry, file, root } = await fixture();
      const keys = join(root, "ces-security", "keys.enc");
      await chmod(keys, 0);
      try {
        await expect(createRootBackup(entry, file)).rejects.toThrow();
        await expect(stat(file)).rejects.toThrow();
      } finally {
        await chmod(keys, 0o600);
      }
    },
  );

  test("Docker restore uses inspected server mounts, streams bytes without host binds, and assigns destination ownership", async () => {
    const { entry, root } = await fixture();
    entry.cloud = "docker";
    const calls: Array<{ args: string[]; source: string }> = [];
    const storage = new DockerRootStorage(entry, {
      output: async (_command, _args) =>
        JSON.stringify([
          {
            Image: "sha256:existing-image",
            State: { Running: false, Status: "exited" },
            Config: { Env: [], User: "1001:1001" },
            Mounts: STATE_ROOTS.map((name) => ({
              Type: "volume",
              Name: `remote-${name}`,
              Source: `/remote/${name}`,
              Destination: `/${name}`,
              RW: true,
            })),
          },
        ]),
      copy: async () => {},
      install: async (args, source) => {
        calls.push({ args, source });
      },
    });
    await storage.replace(root);
    expect(calls).toHaveLength(4);
    for (const { args, source } of calls) {
      expect(args).toContain("--network=none");
      expect(args).toContain("1001:1001");
      expect(args.join(" ")).not.toContain("type=bind");
      expect(source.startsWith(root)).toBe(true);
    }
    expect(
      calls.some(({ args }) =>
        args.includes("type=volume,src=remote-ces-data,dst=/restore"),
      ),
    ).toBe(true);
  });
  test("Docker signing-key conflicts fail preflight before shutdown or writes", async () => {
    const { entry, root, file } = await fixture();
    await packRoot(root, file);
    entry.cloud = "docker";
    let sleeps = 0,
      writes = 0;
    const storage = new DockerRootStorage(entry, {
      output: async () =>
        JSON.stringify([
          {
            Image: "sha256:existing-image",
            State: { Running: true, Status: "running" },
            Config: {
              Env: ["ACTOR_TOKEN_SIGNING_KEY=" + "09".repeat(32)],
              User: "1001:1001",
            },
            Mounts: [],
          },
        ]),
      copy: async () => {},
      install: async () => {
        writes++;
      },
    });
    const ops: RootBackupOps = {
      storage,
      sleep: async () => {
        sleeps++;
      },
      wake: async () => {},
      save: () => {},
    };
    await expect(restoreRootBackup(entry, file, {}, ops)).rejects.toThrow(
      "different signing key",
    );
    expect(sleeps).toBe(0);
    expect(writes).toBe(0);
  });

  test("interrupted startup leaves restored services stopped and keeps the recovery archive", async () => {
    const { entry, root, file, dir } = await fixture();
    await createRootBackup(entry, file);
    const storage = new LocalRootStorage(entry);
    let running = true,
      sleeps = 0;
    const ops: RootBackupOps = {
      storage: {
        running: async () => running,
        capture: (path) => storage.capture(path),
        replace: (path) => storage.replace(path),
      },
      sleep: async () => {
        running = false;
        sleeps++;
      },
      wake: async () => {
        running = true;
        throw new Error("failed startup");
      },
      save: () => {},
    };
    const recovery = join(dir, "recovery.tar.gz");
    await expect(
      restoreRootBackup(entry, file, { recoveryPath: recovery }, ops),
    ).rejects.toThrow("services were stopped");
    expect(running).toBe(false);
    expect(sleeps).toBe(2);
    await validateRootArchive(recovery);
    expect(await readFile(join(root, "workspace", "notes.md"), "utf8")).toBe(
      "source notes",
    );
  });
  test("concurrent captures of one installation are serialized by an operation lock", async () => {
    const { entry, file, dir } = await fixture();
    const storage = new LocalRootStorage(entry);
    let release!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>((done) => {
      release = done;
    });
    const capturing = new Promise<void>((done) => {
      started = done;
    });
    const ops: RootBackupOps = {
      storage: {
        running: async () => false,
        capture: async (path) => {
          started();
          await waiting;
          await storage.capture(path);
        },
        replace: (path) => storage.replace(path),
      },
      sleep: async () => {},
      wake: async () => {},
      save: () => {},
    };
    const first = createRootBackup(entry, file, ops);
    await capturing;
    try {
      await expect(
        createRootBackup(entry, join(dir, "second.tar.gz"), ops),
      ).rejects.toThrow("Another backup/restore");
    } finally {
      release();
      await first;
    }
    await validateRootArchive(file);
  });
  test("deferred recovery restore keeps services stopped so its caller can select the runtime", async () => {
    const { entry, file, dir } = await fixture();
    await createRootBackup(entry, file);
    const storage = new LocalRootStorage(entry);
    let running = true;
    const ops: RootBackupOps = {
      storage: {
        running: async () => running,
        capture: (path) => storage.capture(path),
        replace: (path) => storage.replace(path),
      },
      sleep: async () => {
        running = false;
      },
      wake: async () => {
        throw new Error("caller owns restart");
      },
      save: () => {},
    };
    await restoreRootBackup(
      entry,
      file,
      { recoveryPath: join(dir, "recovery.tar.gz"), resume: false },
      ops,
    );
    expect(running).toBe(false);
  });
});
