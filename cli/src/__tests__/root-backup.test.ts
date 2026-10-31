import { afterEach, describe, expect, spyOn, test } from "bun:test";
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
import type { LockfileAssistant } from "@mycadet/local-mode/contract";
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
} from "../lib/root-backup.js";
import * as sleepModule from "../commands/sleep.js";

// The backup/restore lifecycle constructs its own storage and sleep now, so
// the tests simulate service state through the real seams: the storage
// prototype's methods and the sleep module's assistant entrypoint.
const realRunning = LocalRootStorage.prototype.running;
const realCapture = LocalRootStorage.prototype.capture;
const realReplace = LocalRootStorage.prototype.replace;
const runningMock = spyOn(LocalRootStorage.prototype, "running");
const captureMock = spyOn(LocalRootStorage.prototype, "capture");
const replaceMock = spyOn(LocalRootStorage.prototype, "replace");
const resumeMock = spyOn(LocalRootStorage.prototype, "resume");
const sleepMock = spyOn(sleepModule, "sleepAssistant");

let running: boolean | undefined;
let onCapture: ((path: string) => void) | undefined;
let onReplace: ((path: string) => void) | undefined;
let onResume: (() => void) | undefined;
let onSleep: (() => void) | undefined;

runningMock.mockImplementation(async function (this: LocalRootStorage) {
  if (running === undefined) return realRunning.call(this);
  return running;
});
captureMock.mockImplementation(async function (
  this: LocalRootStorage,
  path: string,
) {
  onCapture?.(path);
  return realCapture.call(this, path);
});
replaceMock.mockImplementation(async function (
  this: LocalRootStorage,
  path: string,
) {
  onReplace?.(path);
  return realReplace.call(this, path);
});
resumeMock.mockImplementation(async () => {
  running = true;
  onResume?.();
});
sleepMock.mockImplementation(async () => {
  onSleep?.();
});

afterEach(() => {
  running = undefined;
  onCapture = undefined;
  onReplace = undefined;
  onResume = undefined;
  onSleep = undefined;
});

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
    instanceDir: root,
    daemonPort: 7821,
    port: 7831,
    cesPort: 7790,
  };
  return { dir, root, entry, file: join(dir, "backup.tar.gz") };
}
afterEach(async () => {
  for (const dir of scratch.splice(0))
    await rm(dir, { recursive: true, force: true });
});

describe("root tar backup", () => {
  test("initializes a fresh stopped instance with complete roots", async () => {
    const { root, entry, file, dir } = await fixture();
    await packRoot(root, file);
    const destination = join(dir, "fresh-instance");
    await mkdir(destination);
    const fresh = {
      ...entry,
      instanceDir: destination,
    };
    await initializeRootArchive(fresh, file);
    expect(
      await readFile(
        join(destination, "gateway-security", "actor-token-signing-key"),
      ),
    ).toEqual(Buffer.from("07".repeat(32), "hex"));
    expect(
      await readFile(join(destination, "ces-security", "keys.enc"), "utf8"),
    ).toBe("opaque encrypted bytes");
    expect(
      await readFile(join(destination, "ces-security", "store.key")),
    ).toEqual(Buffer.alloc(32, 3));
    expect(
      await readFile(join(destination, "ces-data", "grants.json"), "utf8"),
    ).toBe("CES policies");
    expect((await readdir(destination)).sort()).toEqual(
      [...STATE_ROOTS].sort(),
    );
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
    const { entry, file } = await fixture();
    running = true;
    const events: string[] = [];
    onSleep = () => {
      events.push("sleep");
      running = false;
    };
    onCapture = () => {
      events.push("capture");
      expect(running).toBe(false);
    };
    onResume = () => {
      events.push("wake");
    };
    await createRootBackup(entry, file);
    expect(events).toEqual(["sleep", "capture", "wake"]);
    events.length = 0;
    onSleep = () => {
      events.push("sleep");
      throw new Error("refused shutdown");
    };
    await expect(createRootBackup(entry, file)).rejects.toThrow(
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
    running = false;
    onResume = () => {
      throw new Error("must stay stopped");
    };
    expect(
      await restoreRootBackup(entry, file, { recoveryPath: recovery }),
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
    running = false;
    onResume = () => {
      throw new Error("must not wake");
    };
    onSleep = () => {
      throw new Error("must not stop");
    };
    await restoreRootBackup(entry, file, { dryRun: true });
    expect(await readFile(join(root, "workspace", "notes.md"), "utf8")).toBe(
      "destination",
    );
  });

  test("a failed replacement recovers every service root before resuming", async () => {
    const { entry, file, root, dir } = await fixture();
    await createRootBackup(entry, file);
    await writeFile(join(root, "workspace", "notes.md"), "destination");
    let attempts = 0;
    running = true;
    onSleep = () => {
      running = false;
    };
    onReplace = () => {
      attempts++;
      if (attempts === 1) throw new Error("partial restore failure");
    };
    await expect(
      restoreRootBackup(entry, file, {
        recoveryPath: join(dir, "recovery.tar.gz"),
      }),
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
    const dockerEntry: LockfileAssistant = { ...entry, cloud: "docker" };
    const calls: Array<{ args: string[]; source: string }> = [];
    const storage = new DockerRootStorage(dockerEntry, {
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

  test("interrupted startup leaves restored services stopped and keeps the recovery archive", async () => {
    const { entry, root, file, dir } = await fixture();
    await createRootBackup(entry, file);
    running = true;
    let sleeps = 0,
      wakes = 0;
    onSleep = () => {
      running = false;
      sleeps++;
    };
    onResume = () => {
      wakes++;
      if (wakes === 1) throw new Error("failed startup");
      running = true;
    };
    const recovery = join(dir, "recovery.tar.gz");
    await expect(
      restoreRootBackup(entry, file, { recoveryPath: recovery }),
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
    running = false;
    let release!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>((done) => {
      release = done;
    });
    const capturing = new Promise<void>((done) => {
      started = done;
    });
    let firstCaptureCalled = false;
    onCapture = () => {
      if (!firstCaptureCalled) {
        firstCaptureCalled = true;
        started();
        void waiting.then(() => {
          /* released below */
        });
      }
    };
    const first = createRootBackup(entry, file);
    await capturing;
    try {
      await expect(
        createRootBackup(entry, join(dir, "second.tar.gz")),
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
    running = true;
    onSleep = () => {
      running = false;
    };
    onResume = () => {
      throw new Error("caller owns restart");
    };
    await restoreRootBackup(entry, file, {
      recoveryPath: join(dir, "recovery.tar.gz"),
      resume: false,
    });
    expect(running).toBe(false);
  });
});
