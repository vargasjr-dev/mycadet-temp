import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import type { IpcHandle } from "./ipc";

// Exercise the shared spawn and stdout parsing without Electron or a real CLI.
const appState = { isPackaged: false, appPath: "/repo/clients/macos" };
const handlers: Record<
  string,
  (event: unknown, ...args: unknown[]) => unknown
> = {};
const handle: IpcHandle = (channel, schema, fn): void => {
  handlers[channel] = (event, ...args) =>
    fn(schema.parse(args), event as never);
};

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = mock(() => true);
}

let lastChild: FakeChild;
const spawnArgs: Array<[string, string[]]> = [];
const spawnOptions: unknown[] = [];
const spawnMock = mock((command: string, args: string[], options?: unknown) => {
  spawnArgs.push([command, args]);
  spawnOptions.push(options);
  lastChild = new FakeChild();
  return lastChild;
});

const spawnSyncMock = mock(
  (_command: string, _args?: readonly string[], _options?: unknown) => ({
    status: 0,
    stdout: "",
    stderr: "",
  }),
);

mock.module("node:child_process", () => ({
  spawn: spawnMock,
  spawnSync: spawnSyncMock,
}));

// Mock cli-installer with controllable stubs. Defaults: CLI is not installed,
// install succeeds, paths return fixed values.
const cliInstallerState = {
  isInstalled: false,
  installError: null as Error | null,
  cliBinPath: "/fake/userData/cli/0.8.6/node_modules/.bin/cadet",
  bundledBunPath: "/fake/resources/bun",
};
const ensureCliInstalledMock = mock(async () => {
  if (cliInstallerState.installError) {
    throw cliInstallerState.installError;
  }
});

// The module under test imports { existsSync } from "node:fs" to check
// whether the dev source tree exists. Wrap the real implementation so
// dev-mode tests hit an existing path while the lockfile helpers (which
// import `fs` directly above) still use real I/O.
const realExistsSync = fs.existsSync.bind(fs);
const existsSyncOverrides: Record<string, boolean> = {};

// The host's CLI facts, mirroring the real provider: a dev entry behind the
// packaging check, the installed pair behind the installer.
const cliPaths: CliPaths = {
  installed: () => [
    {
      bun: cliInstallerState.bundledBunPath,
      cli: cliInstallerState.cliBinPath,
    },
  ],
  devEntry: () => {
    if (appState.isPackaged) return undefined;
    const repoRoot = path.resolve(appState.appPath, "..", "..");
    const cliEntry = path.join(repoRoot, "cli", "src", "index.ts");
    const exists =
      cliEntry in existsSyncOverrides
        ? existsSyncOverrides[cliEntry]
        : realExistsSync(cliEntry);
    return exists ? cliEntry : undefined;
  },
  prepare: ensureCliInstalledMock,
};

// Point the lockfile transport at a throwaway dir so the lockfile handlers
// exercise the real shared read/write logic without touching a real config
// dir. Set before importing the module under test because `installLocalMode`
// captures the resolved paths once at registration time.
const previousEnvironment = process.env.CADET_ENVIRONMENT;
const previousConfigHome = process.env.XDG_CONFIG_HOME;
const lockfileDir = fs.mkdtempSync(path.join(os.tmpdir(), "cadet-lockfile-"));
const configHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), "cadet-config-"));
process.env.CADET_ENVIRONMENT = "production";
process.env.XDG_CONFIG_HOME = configHomeDir;
const lockfilePath = path.join(lockfileDir, "lockfile.json");

// Matches the module's `resolveConfigDir(process.env)` under the
// production + XDG_CONFIG_HOME environment pinned above.
const configDir = path.join(configHomeDir, "cadet");

let mockSessionToken: string | null = null;

const refreshLockfileNowMock = mock(() => {});

const { configureLocalMode, installLocalMode } = await import("./local-mode");
type CliPaths = import("@mycadet/local-mode").CliPaths;
const { guardianTokenPath } = await import("@mycadet/local-mode");

const allowedEvent = {};

beforeAll(() => {
  configureLocalMode({
    cliPaths,
    handle,
    refreshLockfile: refreshLockfileNowMock,
    session: { getToken: () => mockSessionToken },
  });
  installLocalMode();
});

afterAll(() => {
  if (previousEnvironment === undefined) {
    delete process.env.CADET_ENVIRONMENT;
  } else {
    process.env.CADET_ENVIRONMENT = previousEnvironment;
  }

  if (previousConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = previousConfigHome;
  }

  fs.rmSync(lockfileDir, { recursive: true, force: true });
  fs.rmSync(configHomeDir, { recursive: true, force: true });
});

// The dev CLI entry resolved from the default appPath.
const devCliEntry = path.join("/repo", "cli", "src", "index.ts");

beforeEach(() => {
  // Default: dev source tree "exists" so dev-mode tests pass without
  // a real filesystem.
  existsSyncOverrides[devCliEntry] = true;
});

afterEach(() => {
  appState.isPackaged = false;
  appState.appPath = "/repo/clients/macos";
  spawnArgs.length = 0;
  spawnOptions.length = 0;
  spawnMock.mockClear();
  ensureCliInstalledMock.mockClear();
  cliInstallerState.isInstalled = false;
  cliInstallerState.installError = null;
  mockSessionToken = null;
  refreshLockfileNowMock.mockClear();
  delete process.env.CADET_CLI_PATH;
  for (const key of Object.keys(existsSyncOverrides)) {
    delete existsSyncOverrides[key];
  }
});

// resolveCliInvocation is async, so there is at least one microtask tick
// between calling hatch()/retire() and the point where `spawn` is invoked.
// Yield enough ticks for the async chain to settle before emitting events
// on the fake child process.
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

const hatch = (species?: unknown): Promise<unknown> =>
  handlers["cadet:localMode:hatch"](allowedEvent, species) as Promise<unknown>;

describe("cadet:localMode:hatch handler", () => {
  test("dev: spawns `bun run <repo>/cli/src/index.ts hatch` and parses the id from stdout", async () => {
    const pending = hatch();
    await tick();
    lastChild.stdout.emit(
      "data",
      Buffer.from("Hatching local assistant: asst-42\n"),
    );
    lastChild.emit("close", 0);

    expect(await pending).toEqual({ ok: true, assistantId: "asst-42" });
    expect(spawnArgs[0]).toEqual([
      "bun",
      ["run", path.join("/repo", "cli", "src", "index.ts"), "hatch"],
    ]);
  });

  test("packaged: uses installed CLI when already present", async () => {
    appState.isPackaged = true;
    cliInstallerState.isInstalled = true;

    const pending = hatch();
    await tick();
    lastChild.stdout.emit(
      "data",
      Buffer.from("Hatching local assistant: asst-pkg\n"),
    );
    lastChild.emit("close", 0);

    expect(await pending).toEqual({ ok: true, assistantId: "asst-pkg" });
    expect(spawnArgs[0]).toEqual([
      cliInstallerState.bundledBunPath,
      ["run", cliInstallerState.cliBinPath, "hatch"],
    ]);
    expect(ensureCliInstalledMock).toHaveBeenCalledTimes(1);
  });

  test("packaged: triggers install when CLI not found, then uses installed path", async () => {
    appState.isPackaged = true;
    cliInstallerState.isInstalled = false;

    const pending = hatch();
    await tick();
    lastChild.stdout.emit(
      "data",
      Buffer.from("Hatching local assistant: asst-new\n"),
    );
    lastChild.emit("close", 0);

    expect(await pending).toEqual({ ok: true, assistantId: "asst-new" });
    expect(ensureCliInstalledMock).toHaveBeenCalledTimes(1);
    expect(spawnArgs[0]).toEqual([
      cliInstallerState.bundledBunPath,
      ["run", cliInstallerState.cliBinPath, "hatch"],
    ]);
  });

  test("packaged: returns error when install fails", async () => {
    appState.isPackaged = true;
    cliInstallerState.isInstalled = false;
    cliInstallerState.installError = new Error("network timeout");

    const result = (await hatch()) as { ok: boolean; error: string };

    expect(result.ok).toBe(false);
    expect(result.error).toBe("network timeout");
    expect(spawnArgs).toHaveLength(0);
  });

  test("CADET_CLI_PATH env override takes precedence", async () => {
    process.env.CADET_CLI_PATH = "/custom/cli/index.ts";

    const pending = hatch();
    await tick();
    lastChild.stdout.emit(
      "data",
      Buffer.from("Hatching local assistant: asst-env\n"),
    );
    lastChild.emit("close", 0);

    expect(await pending).toEqual({ ok: true, assistantId: "asst-env" });
    expect(spawnArgs[0]).toEqual([
      "bun",
      ["run", "/custom/cli/index.ts", "hatch"],
    ]);
  });

  test("a non-zero exit resolves to a failure carrying the CLI's stderr", async () => {
    const pending = hatch();
    await tick();
    lastChild.stderr.emit("data", Buffer.from("daemon already running"));
    lastChild.emit("close", 1);

    expect(await pending).toEqual({
      ok: false,
      error: "daemon already running",
    });
  });

  test("a non-zero exit with no output carries a descriptive fallback error", async () => {
    const pending = hatch();
    await tick();
    lastChild.emit("close", 1);

    const result = (await pending) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain("exited with code 1");
  });

  test("a spawn failure resolves to a failure rather than rejecting", async () => {
    const pending = hatch();
    await tick();
    lastChild.emit("error", new Error("ENOENT"));

    const result = (await pending) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ENOENT");
  });

  test("parses the assistant id from a Docker hatch banner", async () => {
    const pending = hatch();
    await tick();
    lastChild.stdout.emit(
      "data",
      Buffer.from("🥚 Hatching Docker assistant: asst-docker\n"),
    );
    lastChild.emit("close", 0);

    expect(await pending).toEqual({ ok: true, assistantId: "asst-docker" });
  });

  test("a zero exit whose stdout has no parseable id fails instead of returning a blank id", async () => {
    const pending = hatch();
    await tick();
    lastChild.stdout.emit("data", Buffer.from("done, but no id line\n"));
    lastChild.emit("close", 0);

    const result = (await pending) as {
      ok: boolean;
      assistantId?: string;
      error: string;
    };
    expect(result.ok).toBe(false);
    expect(result.assistantId).toBeUndefined();
    expect(result.error).toContain("no assistant id");
  });
});

type WriteResult =
  | { ok: true; lockfile: Record<string, unknown> }
  | { ok: false; error: string };

const readLockfile = (): Record<string, unknown> =>
  handlers["cadet:localMode:readLockfile"](allowedEvent) as Record<
    string,
    unknown
  >;
// Seeds the lockfile on disk directly — the renderer save surface is gone,
// so tests stage state the way the disk actually holds it.
const seedLockfileAssistant = (
  entry: Record<string, unknown>,
  activeAssistant?: string,
): void => {
  fs.writeFileSync(
    lockfilePath,
    JSON.stringify({
      assistants: [entry],
      activeAssistant: activeAssistant ?? null,
    }),
  );
};
const writePairedLockfileAssistant = (assistantId: string): void => {
  fs.writeFileSync(
    lockfilePath,
    JSON.stringify({
      assistants: [
        {
          assistantId,
          cloud: "paired",
          paired: true,
          runtimeUrl: "https://h",
        },
      ],
      activeAssistant: assistantId,
    }),
  );
};
const retire = (assistantId?: unknown): Promise<unknown> =>
  handlers["cadet:localMode:retire"](
    allowedEvent,
    assistantId,
  ) as Promise<unknown>;
const unpair = (assistantId?: unknown): WriteResult =>
  handlers["cadet:localMode:unpair"](allowedEvent, assistantId) as WriteResult;
const wake = (assistantId?: unknown, options?: unknown): Promise<unknown> =>
  handlers["cadet:localMode:wake"](
    allowedEvent,
    assistantId,
    options,
  ) as Promise<unknown>;
const upgrade = (assistantId?: unknown, options?: unknown): Promise<unknown> =>
  handlers["cadet:localMode:upgrade"](
    allowedEvent,
    assistantId,
    options,
  ) as Promise<unknown>;
const listDevices = (assistantId?: unknown): Promise<unknown> =>
  handlers["cadet:localMode:listDevices"](
    allowedEvent,
    assistantId,
  ) as Promise<unknown>;
const revokeDevice = (
  assistantId?: unknown,
  hashedDeviceId?: unknown,
): Promise<unknown> =>
  handlers["cadet:localMode:revokeDevice"](
    allowedEvent,
    assistantId,
    hashedDeviceId,
  ) as Promise<unknown>;

describe("lockfile IPC handlers", () => {
  beforeEach(() => {
    fs.rmSync(lockfilePath, { force: true });
  });

  test("readLockfile returns an empty lockfile when none exists yet", () => {
    expect(readLockfile()).toEqual({ assistants: [], activeAssistant: null });
  });

  test("readLockfile returns the parsed contents written to disk", () => {
    fs.writeFileSync(
      lockfilePath,
      JSON.stringify({
        assistants: [{ assistantId: "asst-1", cloud: "local" }],
        activeAssistant: "asst-1",
      }),
    );
    expect(readLockfile()).toEqual({
      assistants: [{ assistantId: "asst-1", cloud: "local" }],
      activeAssistant: "asst-1",
    });
  });

  test("readLockfile throws when the lockfile on disk is corrupt", () => {
    fs.writeFileSync(lockfilePath, "{ not json");
    expect(() => readLockfile()).toThrow();
  });

  // The whole point of routing this through the host: a completion that lands
  // after a retire must not re-create the entry from the renderer's snapshot.
});

describe("cadet:localMode:retire handler", () => {
  test("dev: spawns `... retire <id> --yes` and reports success on a zero exit", async () => {
    const pending = retire("asst-1");
    await tick();
    expect(spawnArgs[0]).toEqual([
      "bun",
      [
        "run",
        path.join("/repo", "cli", "src", "index.ts"),
        "retire",
        "asst-1",
        "--yes",
      ],
    ]);
    lastChild.emit("close", 0);
    expect(await pending).toEqual({ ok: true });
  });

  test("a non-zero exit resolves to a failure carrying the CLI's stderr", async () => {
    const pending = retire("asst-1");
    await tick();
    lastChild.stderr.emit("data", Buffer.from("no such assistant"));
    lastChild.emit("close", 1);
    expect(await pending).toEqual({ ok: false, error: "no such assistant" });
  });

  test("passes the current session token through the shared retire invocation", async () => {
    mockSessionToken = "tok-electron";
    const previousPlatformToken = process.env.CADET_PLATFORM_TOKEN;
    process.env.CADET_PLATFORM_TOKEN = "parent-token";
    try {
      const pending = retire("asst-1");
      await tick();
      lastChild.emit("close", 0);

      expect(await pending).toEqual({ ok: true });
      expect(
        (spawnOptions[0] as { env?: NodeJS.ProcessEnv }).env
          ?.CADET_PLATFORM_TOKEN,
      ).toBe("tok-electron");
      expect(process.env.CADET_PLATFORM_TOKEN).toBe("parent-token");
    } finally {
      if (previousPlatformToken === undefined) {
        delete process.env.CADET_PLATFORM_TOKEN;
      } else {
        process.env.CADET_PLATFORM_TOKEN = previousPlatformToken;
      }
    }
  });

  test("rejects a missing assistant id without spawning", async () => {
    expect(await retire("")).toEqual({
      ok: false,
      error: "Missing assistantId",
    });
    expect(await retire(undefined)).toEqual({
      ok: false,
      error: "Missing assistantId",
    });
    expect(spawnArgs).toHaveLength(0);
  });

  test("packaged: uses installed CLI for retire", async () => {
    appState.isPackaged = true;
    cliInstallerState.isInstalled = true;

    const pending = retire("asst-1");
    await tick();
    expect(spawnArgs[0]).toEqual([
      cliInstallerState.bundledBunPath,
      ["run", cliInstallerState.cliBinPath, "retire", "asst-1", "--yes"],
    ]);
    lastChild.emit("close", 0);
    expect(await pending).toEqual({ ok: true });
  });

  test("packaged: returns error when install fails during retire", async () => {
    appState.isPackaged = true;
    cliInstallerState.isInstalled = false;
    cliInstallerState.installError = new Error("disk full");

    const result = (await retire("asst-1")) as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBe("disk full");
    expect(spawnArgs).toHaveLength(0);
  });
});

describe("cadet:localMode:listDevices handler", () => {
  test("dev: spawns `... devices <id> --json` and returns the parsed devices without a status field", async () => {
    const pending = listDevices("asst-1");
    await tick();
    expect(spawnArgs[0]).toEqual([
      "bun",
      ["run", devCliEntry, "devices", "asst-1", "--json"],
    ]);
    const device = {
      hashedDeviceId: "hash-1",
      platform: "ios",
      issuedAt: 1_000,
      expiresAt: 2_000,
      lastUsedAt: 1_500,
    };
    lastChild.stdout.emit(
      "data",
      Buffer.from(JSON.stringify({ devices: [device] })),
    );
    lastChild.emit("close", 0);
    expect(await pending).toEqual({
      ok: true,
      devices: [
        { ...device, pairingUserAgent: null, clientReportedName: null },
      ],
    });
  });

  test("a non-zero exit resolves to a failure carrying the CLI's stderr", async () => {
    const pending = listDevices("asst-1");
    await tick();
    lastChild.stderr.emit("data", Buffer.from("gateway offline"));
    lastChild.emit("close", 1);
    expect(await pending).toEqual({ ok: false, error: "gateway offline" });
  });

  test("rejects a missing assistant id without spawning", async () => {
    expect(await listDevices("")).toEqual({
      ok: false,
      error: "Missing assistantId",
    });
    expect(await listDevices(undefined)).toEqual({
      ok: false,
      error: "Missing assistantId",
    });
    expect(spawnArgs).toHaveLength(0);
  });
});

describe("cadet:localMode:revokeDevice handler", () => {
  test("dev: spawns `... devices revoke <hash> <id> --yes --json` and reports success on a zero exit", async () => {
    const pending = revokeDevice("asst-1", "hash-1");
    await tick();
    expect(spawnArgs[0]).toEqual([
      "bun",
      [
        "run",
        devCliEntry,
        "devices",
        "revoke",
        "hash-1",
        "asst-1",
        "--yes",
        "--json",
      ],
    ]);
    lastChild.emit("close", 0);
    expect(await pending).toEqual({ ok: true });
  });

  test("a non-zero exit resolves to a failure carrying the CLI's stderr", async () => {
    const pending = revokeDevice("asst-1", "hash-1");
    await tick();
    lastChild.stderr.emit("data", Buffer.from("no such device"));
    lastChild.emit("close", 1);
    expect(await pending).toEqual({ ok: false, error: "no such device" });
  });

  test("rejects missing arguments without spawning", async () => {
    expect(await revokeDevice(undefined, "hash-1")).toEqual({
      ok: false,
      error: "Missing assistantId",
    });
    expect(await revokeDevice("asst-1", undefined)).toEqual({
      ok: false,
      error: "Missing hashedDeviceId",
    });
    expect(spawnArgs).toHaveLength(0);
  });
});

describe("cadet:localMode:unpair handler", () => {
  beforeEach(() => {
    fs.rmSync(lockfilePath, { force: true });
    fs.rmSync(path.join(configDir, "assistants"), {
      recursive: true,
      force: true,
    });
  });

  test("removes a paired entry and deletes its guardian token", () => {
    writePairedLockfileAssistant("paired-1");
    fs.mkdirSync(path.dirname(guardianTokenPath("paired-1")), {
      recursive: true,
    });
    fs.writeFileSync(guardianTokenPath("paired-1"), "{}");

    const result = unpair("paired-1");

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.lockfile.activeAssistant).toBeNull();
    expect(result.lockfile.assistants).toEqual([]);
    expect(fs.existsSync(guardianTokenPath("paired-1"))).toBe(false);
    expect(spawnArgs).toHaveLength(0);
  });

  test("a successful unpair refreshes the lockfile watcher in the same tick", () => {
    writePairedLockfileAssistant("paired-1");
    refreshLockfileNowMock.mockClear();

    const result = unpair("paired-1");

    expect(result.ok).toBe(true);
    expect(refreshLockfileNowMock).toHaveBeenCalledTimes(1);
  });

  test("a failed unpair does not refresh the lockfile watcher", () => {
    // A missing entry is the failure vehicle: the 404 path.
    refreshLockfileNowMock.mockClear();

    const result = unpair("local-1");

    expect(result.ok).toBe(false);
    expect(refreshLockfileNowMock).not.toHaveBeenCalled();
  });

  test("unpairs a local entry too — the gateway refuses what it must", () => {
    seedLockfileAssistant(
      { assistantId: "local-1", cloud: "local" },
      "local-1",
    );

    const result = unpair("local-1");

    expect(result.ok).toBe(true);
  });

  test("rejects a missing assistant id with a structured error", () => {
    expect(unpair("")).toEqual({ ok: false, error: "Missing assistantId" });
    expect(unpair(undefined)).toEqual({
      ok: false,
      error: "Missing assistantId",
    });
  });
});

describe("cadet:localMode:pairing handlers", () => {
  type StartResult = {
    ok: boolean;
    handle?: string;
    userCode?: string | null;
    expiresAt?: string;
    intervalSeconds?: number;
    reason?: string;
    error?: string;
    rejection?: string;
  };
  type PollResult = {
    ok: boolean;
    status?: string;
    assistantId?: string;
    accessOnly?: boolean;
    reason?: string;
    error?: string;
  };

  const pairingStart = (address?: unknown): Promise<StartResult> =>
    handlers["cadet:localMode:pairingStart"](
      allowedEvent,
      address,
    ) as Promise<StartResult>;
  const pairingPoll = (handle?: unknown, name?: unknown): Promise<PollResult> =>
    handlers["cadet:localMode:pairingPoll"](
      allowedEvent,
      handle,
      name,
    ) as Promise<PollResult>;
  const pairingCancel = (handle?: unknown): { ok: boolean } =>
    handlers["cadet:localMode:pairingCancel"](allowedEvent, handle) as {
      ok: boolean;
    };

  const PAIRING_LINK =
    "https://gw.example.com/assistant/pair#device_code=device-code-abc";

  // The exchange itself belongs to `@mycadet/local-mode`; here the gateway is
  // a stub so these cases cover the IPC wiring and nothing else.
  const realFetch = globalThis.fetch;
  let respond: () => Response;
  const setFetch = (): void => {
    globalThis.fetch = (async () => respond()) as unknown as typeof fetch;
  };
  const approvedReply = (): Response =>
    new Response(
      JSON.stringify({
        status: "approved",
        accessToken: "acc-tok",
        refreshAfter: new Date(Date.now() + 1_800_000).toISOString(),
        refreshToken: "refresh-tok",
        refreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

  beforeEach(() => {
    fs.rmSync(lockfilePath, { force: true });
    fs.rmSync(path.join(configDir, "assistants"), {
      recursive: true,
      force: true,
    });
    respond = approvedReply;
    setFetch();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("a pairing link imports on the first poll and refreshes the lockfile", async () => {
    const started = await pairingStart(PAIRING_LINK);

    // The device code stays host-side: the renderer gets a handle and nothing
    // it could replay.
    expect(started.userCode).toBeNull();
    expect(Object.keys(started).sort()).toEqual([
      "expiresAt",
      "handle",
      "intervalSeconds",
      "ok",
      "userCode",
    ]);
    expect(JSON.stringify(started)).not.toContain("device-code-abc");

    const polled = await pairingPoll(started.handle, "desk");

    expect(polled).toEqual({
      ok: true,
      status: "imported",
      assistantId: "desk",
      accessOnly: false,
    });
    expect(refreshLockfileNowMock).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(guardianTokenPath("desk"))).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(lockfilePath, "utf-8")) as {
      assistants: Array<Record<string, unknown>>;
    };
    expect(onDisk.assistants[0]).toMatchObject({
      assistantId: "desk",
      cloud: "paired",
      paired: true,
      runtimeUrl: "https://gw.example.com",
    });
    expect(spawnArgs).toHaveLength(0);
  });

  test("a bare address reports the approval code and stays pending", async () => {
    respond = () =>
      new Response(
        JSON.stringify({
          deviceCode: "device-code-abc",
          userCode: "ABCD-EFGH",
          verificationUri: "https://gw.example.com/assistant/pair",
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          intervalSeconds: 3,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    const started = await pairingStart("https://gw.example.com");

    expect(started.ok).toBe(true);
    expect(started.userCode).toBe("ABCD-EFGH");
    expect(started.intervalSeconds).toBe(3);

    respond = () =>
      new Response(
        JSON.stringify({
          status: "pending",
          expiresAt: new Date(Date.now() + 500_000).toISOString(),
          intervalSeconds: 5,
        }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      );

    const polled = await pairingPoll(started.handle);

    expect(polled.ok).toBe(true);
    expect(polled.status).toBe("pending");
    expect(refreshLockfileNowMock).not.toHaveBeenCalled();
  });

  test("an unusable address is refused without a request", async () => {
    globalThis.fetch = (async () => {
      throw new Error("fetch must not run for an unusable address");
    }) as unknown as typeof fetch;

    const started = await pairingStart("http://localhost:3000");

    expect(started.ok).toBe(false);
    expect(started.reason).toBe("invalid-address");
    expect(started.error).toContain("this machine");
    // The renderer localizes off this, rather than showing the host's English.
    expect(started.rejection).toBe("loopback");
    expect(await pairingStart(undefined)).toMatchObject({
      ok: false,
      reason: "invalid-address",
    });
  });

  test("cancelling a session leaves it unpollable", async () => {
    const started = await pairingStart(PAIRING_LINK);

    expect(pairingCancel(started.handle)).toEqual({ ok: true });
    expect(pairingCancel(started.handle)).toEqual({ ok: false });

    const polled = await pairingPoll(started.handle);

    expect(polled).toMatchObject({ ok: false, reason: "unknown-session" });
    expect(refreshLockfileNowMock).not.toHaveBeenCalled();
  });

  test("refuses to overwrite an existing non-paired assistant", async () => {
    seedLockfileAssistant(
      { assistantId: "local-1", cloud: "local" },
      "local-1",
    );
    const started = await pairingStart(PAIRING_LINK);

    const polled = await pairingPoll(started.handle, "local-1");

    expect(polled.ok).toBe(false);
    // The pre-check reason: the refusal came before the exchange, so the
    // device code is unspent and this session still completes under a free
    // name.
    expect(polled.reason).toBe("import-precheck");
    expect(polled.error).toContain("already exists");
    expect(fs.existsSync(guardianTokenPath("local-1"))).toBe(false);
  });
});

describe("cadet:localMode:wake handler", () => {
  test("forwards repairGuardian to runWake — the repair rides the wake", async () => {
    const pending = wake("asst-1", { repairGuardian: true });
    await tick();
    expect(spawnArgs[0]).toEqual([
      "bun",
      ["run", path.join("/repo", "cli", "src", "index.ts"), "wake", "asst-1"],
    ]);
    lastChild.emit("close", 0);
    await tick(); // the chain spawns the gateway's own re-lease
    lastChild.emit("close", 0);
    expect(await pending).toEqual({ ok: true });
  });

  test("a single-argument invoke still resolves ok with no options forwarded", async () => {
    const pending = handlers["cadet:localMode:wake"](
      allowedEvent,
      "asst-1",
    ) as Promise<unknown>;
    await tick();
    expect(spawnArgs[0]).toEqual([
      "bun",
      ["run", path.join("/repo", "cli", "src", "index.ts"), "wake", "asst-1"],
    ]);
    lastChild.emit("close", 0);
    expect(await pending).toEqual({ ok: true });
  });

  test("rejects malformed options without spawning", async () => {
    expect(() => wake("asst-1", "repair-please")).toThrow();
    expect(spawnArgs).toHaveLength(0);
  });

  test("rejects a missing assistant id without spawning", async () => {
    expect(await wake(undefined, { repairGuardian: true })).toEqual({
      ok: false,
      error: "Missing assistantId",
    });
    expect(spawnArgs).toHaveLength(0);
  });
});

describe("cadet:localMode:upgrade handler", () => {
  beforeEach(() => {
    fs.rmSync(lockfilePath, { force: true });
    seedLockfileAssistant(
      {
        assistantId: "asst-active",
        cloud: "local",
        runtimeUrl: "http://127.0.0.1:1",
      },
      "asst-active",
    );
    spawnArgs.length = 0;
  });

  test("rejects a non-active assistant without spawning the CLI", async () => {
    await expect(upgrade("asst-inactive", { latest: true })).resolves.toEqual({
      ok: false,
      error: "Can only upgrade the active local assistant",
    });
    expect(spawnArgs).toHaveLength(0);
  });

  test("deduplicates concurrent requests before resolving the CLI invocation", async () => {
    const pending = upgrade("asst-active", { latest: true });
    const duplicate = upgrade("asst-active", { latest: true });

    await expect(duplicate).resolves.toEqual({
      ok: false,
      error: "An upgrade is already in progress for this assistant.",
    });

    await tick();
    expect(spawnArgs).toHaveLength(1);
    expect(spawnArgs[0]).toEqual([
      "bun",
      [
        "run",
        path.join("/repo", "cli", "src", "index.ts"),
        "upgrade",
        "asst-active",
        "--latest",
      ],
    ]);

    lastChild.stdout.emit("data", Buffer.from("upgraded to v1.2.3\n"));
    lastChild.emit("close", 0);

    await expect(pending).resolves.toEqual({ ok: true, version: "v1.2.3" });
  });
});

describe("cadet:localMode:readAssistantAvatar handler", () => {
  // Disk-read semantics (manifest precedence, legacy fallbacks, size cap)
  // live with `readLockfileAssistantAvatar` in @mycadet/local-mode; this
  // covers only the IPC wiring around it.
  type AvatarResult =
    | { ok: true; avatar: Record<string, unknown> | null }
    | { ok: false; error: string };
  const readAssistantAvatar = (assistantId?: unknown): AvatarResult =>
    handlers["cadet:localMode:readAssistantAvatar"](
      allowedEvent,
      assistantId,
    ) as AvatarResult;

  const traits = { bodyShape: "round", eyeStyle: "dot", color: "#abc" };
  let instanceDir: string;

  beforeEach(() => {
    instanceDir = fs.mkdtempSync(path.join(os.tmpdir(), "cadet-instance-"));
    fs.writeFileSync(
      lockfilePath,
      JSON.stringify({
        assistants: [
          {
            assistantId: "asst-1",
            cloud: "local",
            runtimeUrl: "http://127.0.0.1:1",
            resources: { instanceDir, gatewayPort: 1, daemonPort: 2 },
          },
        ],
        activeAssistant: "asst-1",
      }),
    );
  });

  afterEach(() => {
    fs.rmSync(instanceDir, { recursive: true, force: true });
    fs.rmSync(lockfilePath, { force: true });
  });

  test("reads the avatar off the lockfile entry's instance dir", () => {
    const avatarDir = path.join(instanceDir, "workspace", "data", "avatar");
    fs.mkdirSync(avatarDir, { recursive: true });
    fs.writeFileSync(
      path.join(avatarDir, "avatar.json"),
      JSON.stringify({ kind: "character", traits }),
    );

    expect(readAssistantAvatar("asst-1")).toEqual({
      ok: true,
      avatar: { kind: "character", traits },
    });
  });

  test("missing lockfile entry yields null", () => {
    expect(readAssistantAvatar("asst-gone")).toEqual({
      ok: true,
      avatar: null,
    });
  });

  test("reports a corrupt lockfile as a failure, not a conclusive none", () => {
    fs.writeFileSync(lockfilePath, "{ not json");

    expect(readAssistantAvatar("asst-1")).toEqual({
      ok: false,
      error: "lockfile unreadable",
    });
  });

  test("entry without an instanceDir reads the default dir from process.env", () => {
    const previousDataHome = process.env.XDG_DATA_HOME;
    const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), "cadet-data-"));
    process.env.XDG_DATA_HOME = dataHome;
    try {
      fs.writeFileSync(
        lockfilePath,
        JSON.stringify({
          assistants: [{ assistantId: "asst-1", cloud: "local" }],
          activeAssistant: "asst-1",
        }),
      );
      const avatarDir = path.join(
        dataHome,
        "cadet",
        "assistants",
        "asst-1",
        "workspace",
        "data",
        "avatar",
      );
      fs.mkdirSync(avatarDir, { recursive: true });
      fs.writeFileSync(
        path.join(avatarDir, "character-traits.json"),
        JSON.stringify(traits),
      );

      expect(readAssistantAvatar("asst-1")).toEqual({
        ok: true,
        avatar: { kind: "character", traits },
      });
    } finally {
      if (previousDataHome === undefined) {
        delete process.env.XDG_DATA_HOME;
      } else {
        process.env.XDG_DATA_HOME = previousDataHome;
      }
      fs.rmSync(dataHome, { recursive: true, force: true });
    }
  });

  test("an unreadable manifest image surfaces as a failure over IPC", () => {
    const avatarDir = path.join(instanceDir, "workspace", "data", "avatar");
    fs.mkdirSync(avatarDir, { recursive: true });
    fs.writeFileSync(
      path.join(avatarDir, "avatar.json"),
      JSON.stringify({
        kind: "image",
        image: { updatedAt: "2026-01-01T00:00:00.000Z", etag: "abc" },
      }),
    );

    expect(readAssistantAvatar("asst-1")).toEqual({
      ok: false,
      error: "avatar image unreadable",
    });
  });

  test("missing assistantId is a structured error", () => {
    expect(readAssistantAvatar(undefined)).toEqual({
      ok: false,
      error: "Missing assistantId",
    });
  });
});
