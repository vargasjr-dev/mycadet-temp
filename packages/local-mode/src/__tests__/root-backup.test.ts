import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { Database } from "bun:sqlite";
import type { ChildProcess } from "node:child_process";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
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
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as net from "node:net";
import * as tar from "tar";
import type { LockfileAssistant } from "@mycadet/local-mode/contract";

// ---------------------------------------------------------------------------
// Boundary mocks. The backup/restore lifecycle talks to the world through
// four real I/O surfaces, and only those are faked — never our own source:
//
//   1. node:child_process — what the lifecycle spawns (`ps` for PID
//      ownership proof, port-to-pid recovery, daemon/gateway/ces starts).
//      Faked as a request-mock: every spawn is journaled; nothing real ever
//      runs.
//   2. process.kill       — the OS signal boundary (liveness probes, SIGTERM
//      stops). Fake pids are tracked in an alive-set so the real
//      liveness/graceful-stop code runs unmodified; real pids pass through.
//   3. node:net           — the port-probe boundary (connect probes used by
//      the allocators and the port-heal). Connects never answer.
//   4. globalThis.fetch   — the network boundary (the gateway health verdict
//      the sleep's wasRunning rides, drain calls, readiness probes).
//      Journaled requests; scripted per-test answers.
//
// Tests script the world (PID files + the alive-set, health answers) and
// assert on the journal: the ordering/failure assertions the old source-level
// mocks made become assertions about real I/O requests. ../root-backup is
// imported dynamically BELOW the mock.module calls, so it binds to the
// mocked builtins.
// ---------------------------------------------------------------------------

/** Above every plausible pid_max (Linux caps at 4194304): never a real pid. */
const FAKE_PID_BASE = 2_000_000_000;

type JournalEntry =
  | { kind: "spawn"; command: string; args: string[] }
  | { kind: "signal"; pid: number; signal: string | number }
  | { kind: "fetch"; url: string };

const journal: JournalEntry[] = [];

// --- 1. node:child_process --------------------------------------------------

const realChildProcess = { ...childProcess };

const alivePids = new Set<number>();

/** Scripted spawn outcomes by substring of "command args"; default: exit 0. */
const spawnScript = new Map<string, "error" | { code: number }>();

/** Where the fake CES sibling binds its socket, set per-fixture. */
let cesSocketPath = "";

let spawnCounter = 0;
function fakeSpawn(command: string, args: string[]): ChildProcess {
  journal.push({ kind: "spawn", command, args });
  const spawned = `${command} ${args.join(" ")}`;
  const scripted = [...spawnScript.entries()].find(([needle]) =>
    spawned.includes(needle),
  )?.[1];
  const isCesSpawn = /credential|ces[\\/]src/.test(spawned);
  const pid = FAKE_PID_BASE + ++spawnCounter;
  const child = new EventEmitter() as EventEmitter & ChildProcess;
  Object.assign(child, {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    killed: false,
    kill: () => true,
    unref: () => {},
    pid: scripted === "error" ? undefined : pid,
  });
  // Absorb the error event when the spawning source attaches no handler of
  // its own — an unhandled 'error' on a child process kills the runner.
  child.on("error", () => {});
  if (scripted !== "error") alivePids.add(pid);
  queueMicrotask(() => {
    if (scripted === "error") child.emit("error", new Error("spawn failed"));
    else {
      // A started CES binds its bootstrap socket; the fake world models
      // that observable effect so the starter's readiness loop sees it.
      if (isCesSpawn && cesSocketPath) writeFileSync(cesSocketPath, "");
      child.emit("close", typeof scripted === "object" ? scripted.code : 0);
    }
  });
  return child;
}

function fakeExecFileSync(command: string, args: string[]): string {
  // `ps -p <pid> -o command=` is how the stop path proves a PID still
  // belongs to a cadet process before killing it. Answer only for pids the
  // fake world says are alive; anything else throws exactly like a dead pid.
  if (command === "ps" && args[0] === "-p") {
    const pid = Number(args[1]);
    if (alivePids.has(pid)) return "bun /home/user/.cadet/cadet-daemon";
    throw new Error(`ps: no process named with pid ${pid}`);
  }
  // Port-to-pid recovery tools see the fake world too: no listeners exist
  // in it (the real host's own listeners must never leak into the journal
  // as recovered daemon pids).
  if (command === "lsof" || command === "fuser" || command === "tasklist.exe")
    throw new Error(`${command}: no matching processes in the fake world`);
  return String(
    realChildProcess.execFileSync(command, args, { encoding: "utf8" }),
  );
}

// --- 2. process.kill (the signal boundary) ----------------------------------

const realKill = process.kill.bind(process);
const mockedKill = (pid: number, signal?: string | number) => {
  if (Math.abs(pid) >= FAKE_PID_BASE) {
    journal.push({ kind: "signal", pid, signal: signal ?? "SIGTERM" });
    if ((signal ?? "SIGTERM") === 0) {
      if (!alivePids.has(pid))
        throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
      return true;
    }
    // A real signal stops the fake service — SIGTERM'd local services
    // exit, which is what the graceful-stop code waits to observe.
    alivePids.delete(Math.abs(pid));
    return true;
  }
  return realKill(pid, signal as never);
};
// A direct assignment (not a spy): another suite's mock.restore() must not
// be able to resurrect the real kill mid-run.
process.kill = mockedKill as typeof process.kill;

// --- 3. node:net (the port-probe boundary) ----------------------------------

const realNet = { ...net };
class NeverConnectingSocket extends EventEmitter {
  setTimeout() {}
  destroy() {}
  connect() {
    queueMicrotask(() =>
      this.emit(
        "error",
        Object.assign(new Error("connect ECONNREFUSED (mocked)"), {
          code: "ECONNREFUSED",
        }),
      ),
    );
  }
}
// The fake world has no listeners: every bind probe succeeds, so the
// port-heal never fires and the allocators hand out the preferred ports.
class AlwaysBindingServer extends EventEmitter {
  listen() {
    queueMicrotask(() => this.emit("listening"));
    return this;
  }
  close(cb?: () => void) {
    cb?.();
    return this;
  }
  address() {
    return {};
  }
  unref() {
    return this;
  }
}

// --- 4. globalThis.fetch (the network boundary) -----------------------------

const realFetch = globalThis.fetch;
const healthPorts = new Set<number>();
/** Ports whose health answers only once their daemon spawn is journaled. */
const afterSpawnPorts = new Set<number>();
/** What `/readyz` answers on scripted health ports: "ready" or "failed". */
let readyzAnswer: "ready" | "failed" = "ready";

const mockedFetch = (async (input: Parameters<typeof fetch>[0]) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  journal.push({ kind: "fetch", url });
  const parsed = new URL(url);
  // A daemon's port answers only once the fake world has seen it spawn —
  // before that it is dark (no orphan adoption, no phantom listeners).
  const port = Number(parsed.port);
  const daemonSpawned = journal.some(
    (e) =>
      e.kind === "spawn" && /daemon/.test(`${e.command} ${e.args.join(" ")}`),
  );
  if (
    healthPorts.has(port) &&
    (!afterSpawnPorts.has(port) || daemonSpawned) &&
    (parsed.pathname.endsWith("/healthz") ||
      parsed.pathname.endsWith("/readyz"))
  ) {
    if (parsed.pathname.endsWith("/readyz"))
      return new Response(
        readyzAnswer === "ready"
          ? JSON.stringify({ ready: true })
          : JSON.stringify({ dbMigrations: { state: "failed" } }),
        { status: 200 },
      );
    // The gateway's /healthz body carries the service-group version — the
    // verdict `sleep`'s wasRunning signal is derived from.
    return new Response(JSON.stringify({ version: "test" }), { status: 200 });
  }
  // Everything else (drain calls, cloud metadata, token refresh) finds no
  // listener — exactly the degraded world a stopped install presents.
  throw new Error(`connect ECONNREFUSED (mocked): ${url}`);
}) as typeof fetch;
globalThis.fetch = mockedFetch as typeof fetch;

// The preload (packages/local-mode/bunfig.toml → test-isolation.ts) runs
// before every test file and snapshots the untouched real modules, so this
// file can re-register them regardless of which sibling registrations the
// scheduler has landed so far.
const preloadGlobals = globalThis as typeof globalThis & {
  __cadetRealProcess?: typeof import("../process");
  __cadetRealDaemonReadiness?: typeof import("../daemon-readiness");
};
const reals = {
  process: preloadGlobals.__cadetRealProcess!,
  daemonReadiness: preloadGlobals.__cadetRealDaemonReadiness!,
};

// The registrations must land before the dynamic import below links the
// lifecycle's graph: mock.module does not propagate to a module that already
// linked, so whatever is registered at load time is what the whole graph
// sees for this file's run. ../process and ../daemon-readiness are
// re-registered from the preload's snapshots (the untouched reals — a
// sibling's per-test registration of them can be the live entry while this
// file loads, because the scheduler interleaves files). These are the last
// word for this process.
mock.module("node:child_process", () => ({
  ...realChildProcess,
  spawn: fakeSpawn,
  execFileSync: fakeExecFileSync,
}));
mock.module("node:net", () => ({
  ...realNet,
  Socket: NeverConnectingSocket,
  createServer: () => new AlwaysBindingServer(),
}));
mock.module("../process", () => reals.process);
mock.module("../daemon-readiness", () => reals.daemonReadiness);

afterAll(() => {
  process.kill = realKill;
  globalThis.fetch = realFetch;
  mock.module("node:child_process", () => realChildProcess);
  mock.module("node:net", () => realNet);
  mock.module("../process", () => reals.process);
  mock.module("../daemon-readiness", () => reals.daemonReadiness);
});

// The journal and the fake process table are per-test state.
afterEach(() => {
  journal.length = 0;
  alivePids.clear();
  healthPorts.clear();
  afterSpawnPorts.clear();
  spawnScript.clear();
  readyzAnswer = "ready";
  cesSocketPath = "";
});

// The module under test binds to the mocked builtins above.
const {
  createRootBackup,
  initializeRootArchive,
  DockerRootStorage,
  LocalRootStorage,
  packRoot,
  restoreRootBackup,
  stageRootArchive,
  withRootOperationLock,
  STATE_ROOTS,
  validateRootArchive,
} = await import("../root-backup");
const { resolveCesSocketPath } = await import("../remotes/local/common");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const scratch: string[] = [];
const defaultConfigHome = process.env.XDG_CONFIG_HOME;
const defaultDataHome = process.env.XDG_DATA_HOME;

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "root-backup-test-"));
  scratch.push(dir);
  // Isolate the XDG-backed state (operation locks, guardian bootstrap
  // secrets) from the ambient home — the tests must see only the world this
  // fixture describes.
  process.env.XDG_CONFIG_HOME = join(dir, "xdg-config");
  process.env.XDG_DATA_HOME = join(dir, "xdg-data");
  const root = join(dir, "instance");
  for (const name of STATE_ROOTS)
    await mkdir(join(root, name), { recursive: true, mode: 0o700 });
  await mkdir(join(root, "workspace", "data", "db"), { recursive: true });
  await writeFile(join(root, "workspace", "notes.md"), "source notes");
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
  cesSocketPath = resolveCesSocketPath(entry);
  return { dir, root, entry, file: join(dir, "backup.tar.gz") };
}

/**
 * Bring the fake world's services up: write the PID files the lifecycle
 * reads and register the fake pids in the alive-set, so `process.kill(pid, 0)`
 * reports them alive and `ps` proves them cadet-owned. Services not listed
 * stay stopped (no PID file at all).
 */
let nextPid = FAKE_PID_BASE;
async function startServices(
  root: string,
  services: Array<"assistant" | "gateway" | "ces">,
) {
  const pidFiles: Array<[string, "assistant" | "gateway" | "ces"]> = [
    [join(root, "workspace", "cadet.pid"), "assistant"],
    [join(root, "gateway.pid"), "gateway"],
    [join(root, "ces.pid"), "ces"],
  ];
  for (const [file, service] of pidFiles) {
    if (!services.includes(service)) continue;
    const pid = nextPid++;
    await writeFile(file, String(pid));
    alivePids.add(pid);
  }
}

afterEach(async () => {
  process.env.XDG_CONFIG_HOME = defaultConfigHome;
  process.env.XDG_DATA_HOME = defaultDataHome;
  for (const dir of scratch.splice(0))
    await rm(dir, { recursive: true, force: true });
});

const sigterms = () =>
  journal.filter((e) => e.kind === "signal" && e.signal === "SIGTERM");
const spawns = () => journal.filter((e) => e.kind === "spawn");

// ---------------------------------------------------------------------------

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

  test("stops services before capture and resumes them after, in journal order", async () => {
    const { root, entry, file } = await fixture();
    await startServices(root, ["assistant", "gateway"]);
    healthPorts.add(7821);
    afterSpawnPorts.add(7821);
    healthPorts.add(7831);
    await createRootBackup(entry, file);

    // The sleep leg really stopped the tracked services: SIGTERMs to the
    // fake pids, and the stop consumed their PID files.
    expect(sigterms().length).toBeGreaterThanOrEqual(2);

    // The resume leg started the world again: CES, daemon and gateway
    // spawned (fresh PID files, all fake pids).
    expect(spawns().length).toBeGreaterThanOrEqual(3);
    for (const pidFile of [
      join(root, "workspace", "cadet.pid"),
      join(root, "gateway.pid"),
      join(root, "ces.pid"),
    ]) {
      expect(Number(await readFile(pidFile, "utf8"))).toBeGreaterThanOrEqual(
        FAKE_PID_BASE,
      );
    }

    // Journal order: the last stop precedes the first resume action, and the
    // 0600 archive exists — capture happened between the stop and the wake.
    const lastStop = journal.findIndex(
      (e) => e.kind === "signal" && e.signal === "SIGTERM",
    );
    const firstSpawn = journal.findIndex((e) => e.kind === "spawn");
    expect(firstSpawn).toBeGreaterThan(lastStop);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  test("an active call lease refuses the sleep, so nothing is captured or stopped", async () => {
    const { root, entry, file } = await fixture();
    await startServices(root, ["assistant"]);
    healthPorts.add(7831);
    // The production refusal path: a phone-call keepalive lease holds the
    // assistant, and the real sleep operation refuses before stopping
    // anything — its structured failure is the error the backup raises.
    await writeFile(
      join(root, "active-call-leases.json"),
      JSON.stringify({ version: 1, leases: [{ callSessionId: "call-1" }] }),
    );
    await expect(createRootBackup(entry, file)).rejects.toThrow(
      "staying awake for active phone calls",
    );
    await expect(stat(file)).rejects.toThrow();
    // Nothing was ever stopped: no signals, and the daemon's PID file still
    // names a live process.
    expect(sigterms()).toEqual([]);
    expect(await readFile(join(root, "workspace", "cadet.pid"), "utf8")).toBe(
      String([...alivePids][0] ?? ""),
    );
  });

  test("restore replaces stale state and retains a restorable recovery archive", async () => {
    const { entry, root, file, dir } = await fixture();
    await createRootBackup(entry, file);
    await writeFile(join(root, "workspace", "notes.md"), "newer destination");
    await writeFile(join(root, "ces-data", "stale.json"), "remove me");
    const recovery = join(dir, "recovery.tar.gz");
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
    // Nothing was running beforehand, so the restore must not touch the
    // process world at all.
    expect(spawns()).toEqual([]);
    expect(sigterms()).toEqual([]);
  });

  test("dry-run leaves services and destination untouched", async () => {
    const { entry, file, root } = await fixture();
    await createRootBackup(entry, file);
    await writeFile(join(root, "workspace", "notes.md"), "destination");
    await restoreRootBackup(entry, file, { dryRun: true });
    expect(await readFile(join(root, "workspace", "notes.md"), "utf8")).toBe(
      "destination",
    );
    expect(spawns()).toEqual([]);
    expect(sigterms()).toEqual([]);
  });

  test("a failed replacement recovers every service root before resuming", async () => {
    const { entry, file, root, dir } = await fixture();
    await createRootBackup(entry, file);
    await writeFile(join(root, "workspace", "notes.md"), "destination");
    // One-shot real fault injected through the module's own dependency-
    // injection seam (the same one initializeRootArchive exposes): the first
    // replacement throws, and the lifecycle's own rollback must recover the
    // pre-restore snapshot. Both attempts call through to the real storage.
    let attempts = 0;
    const storage = new LocalRootStorage(entry);
    const realReplace = storage.replace.bind(storage);
    storage.replace = async (source: string) => {
      attempts++;
      if (attempts === 1) throw new Error("partial restore failure");
      await realReplace(source);
    };
    await startServices(root, ["assistant", "gateway"]);
    healthPorts.add(7821);
    afterSpawnPorts.add(7821);
    healthPorts.add(7831);
    await expect(
      restoreRootBackup(
        entry,
        file,
        { recoveryPath: join(dir, "recovery.tar.gz") },
        storage,
      ),
    ).rejects.toThrow("partial restore failure");
    expect(attempts).toBe(2);
    // The failed restore rolled the snapshot back and resumed the services
    // that were running before it.
    expect(await readFile(join(root, "workspace", "notes.md"), "utf8")).toBe(
      "destination",
    );
    expect(sigterms().length).toBeGreaterThanOrEqual(2);
    expect(spawns().length).toBeGreaterThanOrEqual(2);
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

  test.skipIf(process.platform === "win32" || (process.getuid?.() ?? 0) === 0)(
    "unreadable credential files fail capture without publishing an incomplete archive",
    async () => {
      // Root ignores file permissions entirely, so the chmod-0 mechanism
      // this test rides cannot fail a read there — skip instead of
      // pretending the capture can be made unreadable.
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
    await startServices(root, ["assistant", "gateway"]);
    // The restored state's assistant dies during its restart: the daemon
    // spawn fails (a real spawn-error world), so the wake refuses with
    // "exited during startup" and its cleanup stops everything again.
    healthPorts.add(7821);
    afterSpawnPorts.add(7821);
    healthPorts.add(7831);
    spawnScript.set("/daemon/", "error");
    const recovery = join(dir, "recovery.tar.gz");
    await expect(
      restoreRootBackup(entry, file, { recoveryPath: recovery }),
    ).rejects.toThrow("services were stopped");
    // The failed wake's cleanup stopped the restored services again.
    expect(await lstat(join(root, "gateway.pid")).catch(() => null)).toBeNull();
    expect(
      await lstat(join(root, "workspace", "cadet.pid")).catch(() => null),
    ).toBeNull();
    await validateRootArchive(recovery);
    expect(await readFile(join(root, "workspace", "notes.md"), "utf8")).toBe(
      "source notes",
    );
  });

  test("concurrent captures of one installation are serialized by an operation lock", async () => {
    const { entry, file, dir } = await fixture();
    // Hold the same operation lock the lifecycle takes, fire a concurrent
    // capture at it, then let the holder finish and confirm the capture
    // succeeds once the lock frees.
    let release!: () => void;
    let acquired!: () => void;
    const acquired$ = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const held = withRootOperationLock(entry, () => {
      // Runs only once the lock is held, so the contention below is
      // deterministic.
      acquired();
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await acquired$;
    await expect(createRootBackup(entry, file)).rejects.toThrow(
      "Another backup/restore",
    );
    release();
    await held;
    const second = join(dir, "second.tar.gz");
    await createRootBackup(entry, second);
    await validateRootArchive(second);
  });

  test("deferred recovery restore keeps services stopped so its caller can select the runtime", async () => {
    const { entry, file, dir, root } = await fixture();
    await createRootBackup(entry, file);
    await startServices(root, ["assistant"]);
    healthPorts.add(7831);
    await restoreRootBackup(entry, file, {
      recoveryPath: join(dir, "recovery.tar.gz"),
      resume: false,
    });
    // Services stayed stopped: the PID file was consumed by the stop and no
    // wake was attempted.
    expect(
      await lstat(join(root, "workspace", "cadet.pid")).catch(() => null),
    ).toBeNull();
    expect(spawns()).toEqual([]);
  });
});
