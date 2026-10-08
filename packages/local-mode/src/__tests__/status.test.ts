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
      qdrantPort: 30103,
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
    const result = await getLocalAssistantStatus([lockfilePath], "../other");
    expect(result.ok).toBe(false);
    expect(result.ok ? 200 : result.status).toBe(400);
  });
  test("returns sleeping when the assistant PID file is absent", async () => {
    writeLocalLockfile();

    expect(await getLocalAssistantStatus([lockfilePath], "local-1")).toEqual({
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
      await getLocalAssistantStatus([lockfilePath], "legacy-local"),
    ).toEqual({
      ok: true,
      state: "sleeping",
    });
  });

  test("returns sleeping when the assistant PID file points at a dead process", async () => {
    writeLocalLockfile();
    writeAssistantPid("999999999");

    const result = await getLocalAssistantStatus([lockfilePath], "local-1");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state).toBe("sleeping");
    }
  });

  test("returns crashed when the assistant PID file is invalid", async () => {
    writeLocalLockfile();
    writeAssistantPid("not-a-pid");

    const result = await getLocalAssistantStatus([lockfilePath], "local-1");

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
        qdrantPort: 30103,
      },
    });
    writeAssistantPid(String(process.pid));

    const result = await getLocalAssistantStatus([lockfilePath], "local-1");

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
        qdrantPort: 30103,
      },
    });
    const pidPath = writeAssistantPid(String(process.pid));
    markStale(pidPath);

    const result = await getLocalAssistantStatus([lockfilePath], "local-1");

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
          qdrantPort: 30103,
        },
      });
      writeAssistantPid(String(process.pid));

      const result = await getLocalAssistantStatus([lockfilePath], "local-1");

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
      cloud: "cadet",
      runtimeUrl: "https://example.com",
    });

    expect(await getLocalAssistantStatus([lockfilePath], "platform-1")).toEqual(
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
    expect(resolveLockfileInstanceDir([lockfilePath], "local-1", {})).toEqual({
      ok: true,
      instanceDir,
    });
  });

  test("honors legacy top-level baseDataDir", () => {
    writeLockfile({ assistantId: "local-1", baseDataDir: instanceDir });
    expect(resolveLockfileInstanceDir([lockfilePath], "local-1", {})).toEqual({
      ok: true,
      instanceDir,
    });
  });

  test("falls back to the default instance dir for an entry without one", () => {
    writeLockfile({ assistantId: "local-1", cloud: "local" });
    const dataHome = path.join(tempDir, "data-home");
    expect(
      resolveLockfileInstanceDir([lockfilePath], "local-1", {
        CADET_ENVIRONMENT: "production",
        XDG_DATA_HOME: dataHome,
      }),
    ).toEqual({
      ok: true,
      instanceDir: path.join(dataHome, "cadet", "assistants", "local-1"),
    });
  });

  test("has no instance dir for a missing entry", () => {
    writeLocalLockfile();
    expect(
      resolveLockfileInstanceDir([lockfilePath], "local-2", {
        CADET_ENVIRONMENT: "production",
        XDG_DATA_HOME: tempDir,
      }),
    ).toEqual({ ok: true });
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
    expect(
      resolveLockfileInstanceDir([lockfilePath, legacyPath], "local-1", {}),
    ).toEqual({ ok: false });
  });

  test("empty authoritative lockfile never falls through to a legacy file", () => {
    const legacyPath = path.join(tempDir, "legacy.json");
    writeFileSync(lockfilePath, "");
    writeFileSync(
      legacyPath,
      JSON.stringify({
        assistants: [{ assistantId: "local-1", baseDataDir: instanceDir }],
      }),
    );
    expect(
      resolveLockfileInstanceDir([lockfilePath, legacyPath], "local-1", {}),
    ).toEqual({ ok: true });
  });

  test("never resolves an instance dir for an unsafe assistant id", () => {
    // The parsed contract keeps an unsafe id findable, but resolving its
    // default instance dir would assert — the caller gets absence, not a throw.
    writeLockfile({ assistantId: "../escape", cloud: "local" });
    expect(
      resolveLockfileInstanceDir([lockfilePath], "../escape", {}),
    ).toEqual({ ok: true });
  });
});

// The runtime state classification family: real pid files + real loopback
// servers answering /healthz and /readyz, mirroring the CLI's
// daemon-readiness-probe tests. Only the readyz body/status varies.
describe("runtime state classification", () => {
  type Responder = () => { status: number; body: unknown };

  let daemonServer: Server | null = null;
  let gatewayServer: Server | null = null;
  let daemonPort = 0;
  let gatewayPort = 0;

  /** Serve both probe ports. Everything answers a healthy /healthz; the
   *  optional responder answers the daemon's /readyz. */
  async function serveStack(daemonResponder?: Responder): Promise<void> {
    daemonServer = createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://x").pathname;
      if (pathname === "/readyz" && daemonResponder) {
        const { status, body } = daemonResponder();
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "healthy" }));
    });
    gatewayServer = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "healthy" }));
    });
    [daemonPort, gatewayPort] = await Promise.all([
      listen(daemonServer),
      listen(gatewayServer),
    ]);
  }

  afterEach(async () => {
    if (daemonServer) await close(daemonServer);
    if (gatewayServer) await close(gatewayServer);
    daemonServer = null;
    gatewayServer = null;
  });

  function writeLivePids(): void {
    writeAssistantPid(String(process.pid));
    writeFileSync(path.join(instanceDir, "gateway.pid"), String(process.pid));
  }

  function writeStackLockfile(): void {
    writeLocalLockfile({
      resources: { instanceDir, daemonPort, gatewayPort, qdrantPort: 0 },
    });
  }

  test("reports healthy when both processes answer and the daemon is migration-ready", async () => {
    await serveStack(() => ({ status: 200, body: { ready: true } }));
    writeStackLockfile();
    writeLivePids();

    expect(await getLocalAssistantStatus([lockfilePath], "local-1")).toEqual({
      ok: true,
      state: "healthy",
      pid: process.pid,
    });
  });

  test("reports unhealthy when the daemon's readyz says migrations failed", async () => {
    await serveStack(() => ({
      status: 200,
      body: { ready: false, dbMigrations: { ready: false, state: "failed" } },
    }));
    writeStackLockfile();
    writeLivePids();

    const result = await getLocalAssistantStatus([lockfilePath], "local-1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state).toBe("unhealthy");
      expect(result.detail).toContain("migrations failed");
    }
  });

  test("reports starting while the daemon is mid-migration", async () => {
    await serveStack(() => ({
      status: 200,
      body: { ready: false, dbMigrations: { ready: false, state: "running" } },
    }));
    writeStackLockfile();
    writeLivePids();

    const result = await getLocalAssistantStatus([lockfilePath], "local-1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state).toBe("starting");
      expect(result.detail).toContain("migrations are running");
    }
  });

  test("treats a legacy strict-503 readyz body as migrating, not crashed", async () => {
    await serveStack(() => ({
      // A pre-dbMigrations daemon: 503 with no dbMigrations field.
      status: 503,
      body: { status: "starting" },
    }));
    writeStackLockfile();
    writeLivePids();

    const result = await getLocalAssistantStatus([lockfilePath], "local-1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state).toBe("starting");
    }
  });

  test("reports crashed when a stale live gateway stops answering its health check", async () => {
    await serveStack();
    writeStackLockfile();
    const pidPath = writeAssistantPid(String(process.pid));
    const gatewayPidPath = path.join(instanceDir, "gateway.pid");
    writeFileSync(gatewayPidPath, String(process.pid));
    markStale(pidPath);
    markStale(gatewayPidPath);
    // Non-200 on the gateway's /healthz = not responding.
    gatewayServer?.removeAllListeners("request");
    gatewayServer?.on("request", (_req, res) => {
      res.writeHead(500);
      res.end();
    });

    const result = await getLocalAssistantStatus([lockfilePath], "local-1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state).toBe("crashed");
      expect(result.detail).toBe("gateway process is not responding");
      expect(result.pid).toBe(process.pid);
    }
  });

  test("reports starting when a fresh gateway pid has not bound its port yet", async () => {
    await serveStack();
    writeStackLockfile();
    const pidPath = writeAssistantPid(String(process.pid));
    markStale(pidPath);
    // The gateway just started: pid file fresh, port not answering yet.
    writeFileSync(path.join(instanceDir, "gateway.pid"), String(process.pid));
    gatewayServer?.removeAllListeners("request");

    const result = await getLocalAssistantStatus([lockfilePath], "local-1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state).toBe("starting");
    }
  });

  test("reports crashed when a stale live assistant answers its health check with a non-200", async () => {
    await serveStack();
    writeStackLockfile();
    const pidPath = writeAssistantPid(String(process.pid));
    markStale(pidPath);
    // Non-200 on the daemon's /healthz = not responding.
    daemonServer?.removeAllListeners("request");
    daemonServer?.on("request", (_req, res) => {
      res.writeHead(500);
      res.end();
    });

    const result = await getLocalAssistantStatus([lockfilePath], "local-1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state).toBe("crashed");
      expect(result.detail).toContain("assistant process is not responding");
    }
  });

  test("reports crashed when a stale live assistant has no gateway pid at all", async () => {
    await serveStack();
    writeStackLockfile();
    const pidPath = writeAssistantPid(String(process.pid));
    markStale(pidPath);

    const result = await getLocalAssistantStatus([lockfilePath], "local-1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state).toBe("crashed");
      expect(result.detail).toBe("gateway process is not running");
    }
  });

  test("propagates the unreadable-lockfile error to status callers", async () => {
    writeFileSync(lockfilePath, "{ not json");

    const result = await getLocalAssistantStatus([lockfilePath], "local-1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
      expect(result.error).toContain("lockfile");
    }
  });

  test("dials the environment seed's ports when the lockfile carries none", async () => {
    // No ports in the lockfile: the dev seed's daemon port (18000), not the
    // code defaults (7821), must receive the probe. A live server on 18000
    // plus a stale pid proves the dial by answering it.
    const devSeedDaemonPort = 18000;
    daemonServer = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "healthy" }));
    });
    await new Promise<void>((resolve) => {
      daemonServer!.listen(devSeedDaemonPort, "127.0.0.1", resolve);
    });
    writeLocalLockfile({ resources: { instanceDir, qdrantPort: 0 } });
    const pidPath = writeAssistantPid(String(process.pid));
    markStale(pidPath);

    const result = await getLocalAssistantStatus([lockfilePath], "local-1", {
      CADET_ENVIRONMENT: "dev",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The daemon answered, so the run continues to the gateway check.
      expect(result.state).toBe("crashed");
      expect(result.detail).toBe("gateway process is not running");
    }
  });
});
