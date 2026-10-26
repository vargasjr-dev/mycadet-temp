import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { getLocalAssistantStatus, resolveLockfileInstanceDir } from "../status";

let tempDir: string;
let lockfilePath: string;
let instanceDir: string;

function writeLockfile(entry: Record<string, unknown>): void {
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
    resources: {
      instanceDir,
      daemonPort: 30101,
      gatewayPort: 30102,
    },
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
  lockfilePath = path.join(tempDir, "lockfile.json");
  instanceDir = path.join(tempDir, "instance");
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("getLocalAssistantStatus", () => {
  test("returns a structured error for unsafe assistant IDs", async () => {
    const result = await getLocalAssistantStatus(lockfilePath, "../other");
    expect(result.ok).toBe(false);
    expect(result.ok ? 200 : result.status).toBe(400);
  });
  test("returns sleeping when the assistant PID file is absent", async () => {
    writeLocalLockfile();

    expect(await getLocalAssistantStatus(lockfilePath, "local-1")).toEqual({
      ok: true,
      state: "sleeping",
    });
  });

  test("returns sleeping for legacy local entries without cloud/resources", async () => {
    writeLockfile({
      assistantId: "legacy-local",
      baseDataDir: instanceDir,
      runtimeUrl: "http://127.0.0.1:30102",
    });

    expect(
      await getLocalAssistantStatus(lockfilePath, "legacy-local"),
    ).toEqual({
      ok: true,
      state: "sleeping",
    });
  });

  test("returns sleeping when the assistant PID file points at a dead process", async () => {
    writeLocalLockfile();
    writeAssistantPid("999999999");

    const result = await getLocalAssistantStatus(lockfilePath, "local-1");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state).toBe("sleeping");
    }
  });

  test("returns crashed when the assistant PID file is invalid", async () => {
    writeLocalLockfile();
    writeAssistantPid("not-a-pid");

    const result = await getLocalAssistantStatus(lockfilePath, "local-1");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state).toBe("crashed");
      expect(result.detail).toContain("PID file");
    }
  });

  test("returns starting when a fresh assistant PID is alive but health is not ready yet", async () => {
    writeLocalLockfile({
      resources: {
        instanceDir,
        daemonPort: await unusedPort(),
        gatewayPort: 30102,
      },
    });
    writeAssistantPid(String(process.pid));

    const result = await getLocalAssistantStatus(lockfilePath, "local-1");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state).toBe("starting");
      expect(result.pid).toBe(process.pid);
    }
  });

  test("returns crashed when an old live assistant PID is still not responding", async () => {
    writeLocalLockfile({
      resources: {
        instanceDir,
        daemonPort: await unusedPort(),
        gatewayPort: 30102,
      },
    });
    const pidPath = writeAssistantPid(String(process.pid));
    markStale(pidPath);

    const result = await getLocalAssistantStatus(lockfilePath, "local-1");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state).toBe("crashed");
      expect(result.detail).toContain("not responding");
    }
  });

  test("returns starting while the gateway is coming up for a freshly started assistant", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "healthy" }));
    });
    const daemonPort = await listen(server);
    try {
      writeLocalLockfile({
        resources: {
          instanceDir,
          daemonPort,
          gatewayPort: await unusedPort(),
        },
      });
      writeAssistantPid(String(process.pid));

      const result = await getLocalAssistantStatus(lockfilePath, "local-1");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.state).toBe("starting");
        expect(result.pid).toBe(process.pid);
      }
    } finally {
      await close(server);
    }
  });

  test("rejects non-local assistants", async () => {
    writeLockfile({
      assistantId: "platform-1",
      cloud: "cloud",
      runtimeUrl: "https://example.com",
    });

    expect(await getLocalAssistantStatus(lockfilePath, "platform-1")).toEqual(
      {
        ok: false,
        status: 404,
        error: "Local assistant not found",
      },
    );
  });
});

describe("resolveLockfileInstanceDir", () => {
  test("reads the instance dir from the parsed entry", () => {
    writeLocalLockfile();
    expect(resolveLockfileInstanceDir(lockfilePath, "local-1")).toEqual({
      ok: true,
      instanceDir,
    });
  });

  test("honors legacy top-level baseDataDir", () => {
    writeLockfile({ assistantId: "local-1", baseDataDir: instanceDir });
    expect(resolveLockfileInstanceDir(lockfilePath, "local-1")).toEqual({
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
      expect(resolveLockfileInstanceDir(lockfilePath, "local-1")).toEqual({
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
      expect(resolveLockfileInstanceDir(lockfilePath, "local-2")).toEqual({
        ok: true,
      });
    } finally {
      Reflect.deleteProperty(process.env, "CADET_ENVIRONMENT");
      Reflect.deleteProperty(process.env, "XDG_DATA_HOME");
    }
  });

  test("fails when the authoritative lockfile is unreadable", () => {
    const legacyPath = path.join(tempDir, "legacy.json");
    writeFileSync(lockfilePath, "{ not json");
    writeFileSync(
      legacyPath,
      JSON.stringify({
        assistants: [{ assistantId: "local-1", baseDataDir: instanceDir }],
      }),
    );
    expect(resolveLockfileInstanceDir(lockfilePath, "local-1")).toEqual({
      ok: false,
    });
  });

});
