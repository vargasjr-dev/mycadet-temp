import * as childProcess from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";

import {
  appServerStatePath,
  getAppServerPaths,
  readAppServerState,
  stopAppServer,
} from "../lib/servers/bun.js";

const realChildProcess = { ...childProcess };

const execFileSyncMock = mock(childProcess.execFileSync);

mock.module("node:child_process", () => ({
  ...childProcess,
  execFileSync: execFileSyncMock,
}));

afterAll(() => {
  mock.module("node:child_process", () => realChildProcess);
});

const originalKill = process.kill;
const workspaces: string[] = [];
const originalWorkspaceDir = process.env.CADET_WORKSPACE_DIR;
const originalDataHome = process.env.XDG_DATA_HOME;
const originalConfigHome = process.env.XDG_CONFIG_HOME;

afterEach(() => {
  if (originalConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = originalConfigHome;
  }
  process.kill = originalKill;
  execFileSyncMock.mockReset();
  execFileSyncMock.mockImplementation(realChildProcess.execFileSync);
  for (const dir of workspaces.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  if (originalWorkspaceDir === undefined) {
    delete process.env.CADET_WORKSPACE_DIR;
  } else {
    process.env.CADET_WORKSPACE_DIR = originalWorkspaceDir;
  }
  if (originalDataHome === undefined) {
    delete process.env.XDG_DATA_HOME;
  } else {
    process.env.XDG_DATA_HOME = originalDataHome;
  }
});

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "cadet-app-server-state-test-"));
  workspaces.push(dir);
  process.env.CADET_WORKSPACE_DIR = dir;
  process.env.XDG_CONFIG_HOME = dir;
  process.env.XDG_DATA_HOME = dir;
  return dir;
}

function writeState(state: Record<string, unknown>): void {
  mkdirSync(getAppServerPaths().dir, { recursive: true });
  writeFileSync(appServerStatePath(), JSON.stringify(state, null, 2) + "\n");
}

function writePidFile(pid: number): void {
  mkdirSync(getAppServerPaths().dir, { recursive: true });
  writeFileSync(getAppServerPaths().pidPath, `${pid}\n`);
}

/** A live server of ours: pidfile + a ps answer naming the state dir. */

/** SIGTERM to the given PID marks it dead; signal 0 reflects liveness. */

describe("the app server's stop state", () => {
  test("clears state after the server is confirmed stopped", async () => {
    makeWorkspace();
    const pid = 123_456;
    let alive = true;
    writeState({ listenPort: 7841 });
    writePidFile(pid);
    execFileSyncMock.mockReturnValue(
      `bun app-server.ts ${getAppServerPaths().dir}`,
    );
    process.kill = mock((targetPid: number, signal?: string | number): true => {
      if (targetPid !== pid) return originalKill(targetPid, signal);
      if (signal === 0) {
        if (!alive) throw new Error("dead");
        return true;
      }
      if (signal === "SIGTERM") {
        alive = false;
        return true;
      }
      return true;
    });

    await expect(stopAppServer()).resolves.toBe(true);

    expect(readAppServerState()).toBeNull();
    expect(existsSync(getAppServerPaths().pidPath)).toBe(false);
  });

  test("keeps state when the kill fails", async () => {
    makeWorkspace();
    const pid = 123_457;
    writeState({ listenPort: 7841 });
    writePidFile(pid);
    execFileSyncMock.mockReturnValue(
      `bun app-server.ts ${getAppServerPaths().dir}`,
    );
    process.kill = mock((targetPid: number, signal?: string | number): true => {
      if (targetPid !== pid) return originalKill(targetPid, signal);
      if (signal === 0) return true;
      throw new Error("operation not permitted");
    });

    await expect(stopAppServer()).resolves.toBe(false);

    expect(readAppServerState()).toEqual({ listenPort: 7841 });
    expect(existsSync(getAppServerPaths().pidPath)).toBe(true);
  });

  test("clears state when the server exits before the SIGTERM lands", async () => {
    makeWorkspace();
    const pid = 123_458;
    let aliveChecks = 0;
    writeState({ listenPort: 7841 });
    writePidFile(pid);
    execFileSyncMock.mockReturnValue(
      `bun app-server.ts ${getAppServerPaths().dir}`,
    );
    process.kill = mock((targetPid: number, signal?: string | number): true => {
      if (targetPid !== pid) return originalKill(targetPid, signal);
      if (signal === 0) {
        aliveChecks++;
        if (aliveChecks === 1) return true;
        throw new Error("dead");
      }
      throw new Error("no such process");
    });

    await expect(stopAppServer()).resolves.toBe(true);

    expect(readAppServerState()).toBeNull();
    expect(existsSync(getAppServerPaths().pidPath)).toBe(false);
  });

  test("does not kill another server when clearing stale state", async () => {
    makeWorkspace();
    const pid = 123_459;
    writeState({ listenPort: 7841 });
    writePidFile(pid);
    // A ps answer that does not name OUR state dir: some other process.
    execFileSyncMock.mockReturnValue(
      "bun app-server.ts /tmp/other-workspace/app-server",
    );
    process.kill = mock((targetPid: number, signal?: string | number): true => {
      if (targetPid !== pid) return originalKill(targetPid, signal);
      if (signal === 0) return true;
      throw new Error("should not kill another server");
    });

    await expect(stopAppServer()).resolves.toBe(false);

    expect(readAppServerState()).toBeNull();
    expect(existsSync(getAppServerPaths().pidPath)).toBe(false);
  });

  test("reads a pre-rename install's state from the legacy ingress dir", () => {
    makeWorkspace();
    // The renamed dir has no record; the pre-rename one (the data dir's
    // own "ingress" sibling) does.
    const legacyDir = join(getAppServerPaths().dir, "..", "ingress");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      join(legacyDir, "state.json"),
      JSON.stringify({ listenPort: 7842 }) + "\n",
    );

    expect(readAppServerState()).toEqual({ listenPort: 7842 });
  });
});
