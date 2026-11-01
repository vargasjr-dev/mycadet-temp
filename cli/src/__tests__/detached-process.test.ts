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
import * as childProcess from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const realChildProcess = { ...childProcess };

function makeFakeChild(pid: number): ChildProcess {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    stdout: null,
    stderr: null,
    killed: false,
    kill: () => true,
    unref: () => {},
    pid,
  }) as unknown as ChildProcess;
}

type SpawnCall = [
  command: string,
  args: readonly string[],
  options?: SpawnOptions,
];
type SpawnFn = (...args: SpawnCall) => ChildProcess;

const spawnMock = mock<SpawnFn>(() => makeFakeChild(1111));

beforeAll(() => {
  mock.module("node:child_process", () => ({
    ...realChildProcess,
    spawn: spawnMock,
  }));
});

afterAll(() => {
  mock.module("node:child_process", () => realChildProcess);
});

const { relaunchDetached } = await import("../lib/detached-process.js");

const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const tempDirs: string[] = [];

describe("relaunchDetached", () => {
  beforeEach(() => {
    spawnMock.mockClear();
    const configHome = mkdtempSync(join(tmpdir(), "cadet-detached-xdg-"));
    tempDirs.push(configHome);
    process.env.XDG_CONFIG_HOME = configHome;
  });

  afterEach(() => {
    if (originalXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("spawns the current binary detached with the given args and reports readiness", async () => {
    spawnMock.mockImplementationOnce(() => makeFakeChild(2222));

    const result = await relaunchDetached({
      args: ["tunnel", "--provider", "ngrok"],
      logFile: "relaunch-ready.log",
      timeoutMs: 1000,
      pollIntervalMs: 10,
      isReady: () => true,
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnMock.mock.calls[0] as unknown as [
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(cmd).toBe(process.execPath);
    expect(args).toContain("tunnel");
    expect(args).toContain("--provider");
    expect(args).toContain("ngrok");
    expect(opts.detached).toBe(true);

    expect(result.ready).toBe(true);
    expect(result.exitCode).toBeUndefined();
    expect(result.child.pid).toBe(2222);
    expect(result.logPath.endsWith("relaunch-ready.log")).toBe(true);
  });

  test("passes the resolved log path into isReady", async () => {
    spawnMock.mockImplementationOnce(() => makeFakeChild(3333));
    const seenPaths: string[] = [];

    const result = await relaunchDetached({
      args: ["tunnel"],
      logFile: "relaunch-logpath.log",
      timeoutMs: 1000,
      pollIntervalMs: 10,
      isReady: (logPath) => {
        seenPaths.push(logPath);
        return true;
      },
    });

    expect(seenPaths).toEqual([result.logPath]);
  });

  test("stops polling and reports the exit code once the child exits before readiness", async () => {
    spawnMock.mockImplementationOnce(() => {
      const child = makeFakeChild(4444);
      // Listeners attach synchronously right after spawn() returns; defer the
      // exit so they're in place before it fires.
      setTimeout(() => (child as unknown as EventEmitter).emit("exit", 7), 0);
      return child;
    });

    const result = await relaunchDetached({
      args: ["tunnel"],
      logFile: "relaunch-exit.log",
      timeoutMs: 1000,
      pollIntervalMs: 10,
      isReady: () => false,
    });

    expect(result.ready).toBe(false);
    expect(result.exitCode).toBe(7);
  });

  test("rides the source entry script along and merges env into the child", async () => {
    spawnMock.mockImplementationOnce(() => makeFakeChild(6666));
    const entryDir = mkdtempSync(join(tmpdir(), "cadet-detached-entry-"));
    tempDirs.push(entryDir);
    const entry = join(entryDir, "entry.ts");
    (await import("node:fs")).writeFileSync(entry, "export {};", "utf-8");

    const originalArgv = process.argv;
    process.argv = [process.execPath, entry];
    try {
      const result = await relaunchDetached({
        args: ["tunnel", "start"],
        env: { CADET_TUNNEL_DETACHED_CHILD: "1" },
        logFile: "relaunch-source-entry.log",
        timeoutMs: 1000,
        pollIntervalMs: 10,
        isReady: () => true,
      });

      expect(result.ready).toBe(true);
      const [cmd, args, opts] = spawnMock.mock.calls[0];
      // Source checkout shape: `bun <entry.ts> tunnel start` — the entry
      // rides along, or bun would try to execute a script named "tunnel".
      expect(cmd).toBe(process.execPath);
      expect(args[0]).toBe(entry);
      expect(args[1]).toBe("tunnel");
      expect(args[2]).toBe("start");
      // The child env is the parent's env plus the caller's marker.
      expect(opts?.env?.CADET_TUNNEL_DETACHED_CHILD).toBe("1");
      expect(opts?.env?.PATH).toBe(process.env.PATH);
    } finally {
      process.argv = originalArgv;
    }
  });

  test("does not ride a non-script argv[1] along (compiled-binary shape)", async () => {
    spawnMock.mockImplementationOnce(() => makeFakeChild(7777));

    const originalArgv = process.argv;
    // A compiled binary's argv[1] is the first user argument, not a script.
    process.argv = [process.execPath, "tunnel"];
    try {
      await relaunchDetached({
        args: ["tunnel", "start"],
        logFile: "relaunch-compiled.log",
        timeoutMs: 1000,
        pollIntervalMs: 10,
        isReady: () => true,
      });

      const [cmd, args] = spawnMock.mock.calls[0];
      expect(cmd).toBe(process.execPath);
      expect(args[0]).toBe("tunnel");
      expect(args[1]).toBe("start");
    } finally {
      process.argv = originalArgv;
    }
  });

  test("gives up once timeoutMs elapses with no readiness and no exit", async () => {
    spawnMock.mockImplementationOnce(() => makeFakeChild(5555));

    const result = await relaunchDetached({
      args: ["tunnel"],
      logFile: "relaunch-timeout.log",
      timeoutMs: 60,
      pollIntervalMs: 10,
      isReady: () => false,
    });

    expect(result.ready).toBe(false);
    expect(result.exitCode).toBeUndefined();
    expect(result.child.pid).toBe(5555);
  });
});
