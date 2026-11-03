import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveLockfileInstanceDir } from "../status";

let tempDir: string;
let lockfilePath: string;
let instanceDir: string;

function writeLockfile(entry: Record<string, unknown>): void {
  mkdirSync(path.dirname(lockfilePath), { recursive: true });
  writeFileSync(
    lockfilePath,
    JSON.stringify({
      assistants: [entry],
      activeAssistant: entry.assistantId,
    }),
  );
}

function writeLocalLockfile(overrides: Record<string, unknown> = {}): void {
  writeLockfile({
    assistantId: "local-1",
    cloud: "local",
    instanceDir,
    daemonPort: 30101,
    port: 30102,
    ...overrides,
  });
}

function writeAssistantPid(value: string): string {
  const pidDir = path.join(instanceDir, "workspace");
  mkdirSync(pidDir, { recursive: true });
  const pidPath = path.join(pidDir, "cadet.pid");
  writeFileSync(pidPath, value);
  return pidPath;
}

function markStale(filePath: string): void {
  const stale = new Date(Date.now() - 120_000);
  utimesSync(filePath, stale, stale);
}

function listen(server: Server, port = 0): Promise<number> {
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected TCP server address");
      }
      resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

beforeEach(() => {
  tempDir = path.join(
    tmpdir(),
    `cadet-local-status-test-${Date.now()}-${Math.random()}`,
  );
  mkdirSync(tempDir, { recursive: true });
  // The status reads resolve their lockfile from the environment.
  process.env.XDG_CONFIG_HOME = tempDir;
  lockfilePath = path.join(tempDir, "cadet", "lockfile.json");
  instanceDir = path.join(tempDir, "instance");
});

afterEach(() => {
  Reflect.deleteProperty(process.env, "XDG_CONFIG_HOME");
  rmSync(tempDir, { recursive: true, force: true });
});

describe("resolveLockfileInstanceDir", () => {
  test("reads the instance dir from the parsed entry", () => {
    writeLocalLockfile();
    expect(resolveLockfileInstanceDir("local-1")).toEqual({
      ok: true,
      instanceDir,
    });
  });

  test("reads the recorded instance dir off the entry", () => {
    writeLockfile({
      assistantId: "local-1",
      cloud: "local",
      instanceDir,
    });
    expect(resolveLockfileInstanceDir("local-1")).toEqual({
      ok: true,
      instanceDir,
    });
  });

  test("falls back to the default instance dir for an entry without one", () => {
    writeLockfile({ assistantId: "local-1", cloud: "local" });
    const dataHome = path.join(tempDir, "data-home");
    // The resolvers read process.env directly; steer them for this test.
    process.env.CADET_ENVIRONMENT = "production";
    process.env.XDG_DATA_HOME = dataHome;
    try {
      expect(resolveLockfileInstanceDir("local-1")).toEqual({
        ok: true,
        instanceDir: path.join(dataHome, "cadet", "assistants", "local-1"),
      });
    } finally {
      Reflect.deleteProperty(process.env, "CADET_ENVIRONMENT");
      Reflect.deleteProperty(process.env, "XDG_DATA_HOME");
    }
  });

  test("has no instance dir for a missing entry", () => {
    writeLocalLockfile();
    process.env.CADET_ENVIRONMENT = "production";
    process.env.XDG_DATA_HOME = tempDir;
    try {
      expect(resolveLockfileInstanceDir("local-2")).toEqual({
        ok: true,
      });
    } finally {
      Reflect.deleteProperty(process.env, "CADET_ENVIRONMENT");
      Reflect.deleteProperty(process.env, "XDG_DATA_HOME");
    }
  });

  test("fails when the authoritative lockfile is unreadable", () => {
    const legacyPath = path.join(tempDir, "legacy.json");
    mkdirSync(path.dirname(lockfilePath), { recursive: true });
    writeFileSync(lockfilePath, "{ not json");
    writeFileSync(
      legacyPath,
      JSON.stringify({
        assistants: [{ assistantId: "local-1", cloud: "local" }],
      }),
    );
    expect(resolveLockfileInstanceDir("local-1")).toEqual({
      ok: false,
    });
  });
});
