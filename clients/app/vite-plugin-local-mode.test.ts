/**
 * Tests for the dev-server's local-host middlewares and the gateway data
 * plane. Local assistant credentials stay inside the trusted host proxy.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter, once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ViteDevServer, Connect } from "vite";

import {
  AVATAR_IMAGE_FILENAME,
  AVATAR_MANIFEST_FILENAME,
  AVATAR_TRAITS_FILENAME,
  resolveAvatarDir,
} from "@mycadet/avatar-manifest";
import * as actualLocalMode from "@mycadet/local-mode";
import {
  guardianTokenPath,
  type DevicesListResult,
  type DevicesRevokeResult,
} from "@mycadet/local-mode";

// Per-test stubs for the CLI-spawning device helpers. The rest of the module
// stays real so the other middlewares under test keep their behavior.
let devicesListResult: DevicesListResult = { ok: true, devices: [] };
let devicesRevokeResult: DevicesRevokeResult = { ok: true };
const runDevicesListMock = mock((_invocation: unknown, _assistantId: string) =>
  Promise.resolve(devicesListResult),
);
const runDevicesRevokeMock = mock(
  (_invocation: unknown, _assistantId: string, _hashedDeviceId: string) =>
    Promise.resolve(devicesRevokeResult),
);

mock.module("@mycadet/local-mode", () => {
  const mocked: Partial<typeof import("@mycadet/local-mode")> = {
    ...actualLocalMode,
    resolveDevCliInvocation: () => ({ command: "cadet", baseArgs: [] }),
    runDevicesList: runDevicesListMock,
    runDevicesRevoke: runDevicesRevokeMock,
  };
  return mocked;
});

import { localModePlugin } from "./vite-plugin-local-mode";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vite-local-mode-"));
const env = {
  CADET_ENVIRONMENT: "production",
  CADET_LOCKFILE_DIR: tempDir,
  XDG_CONFIG_HOME: tempDir,
  XDG_DATA_HOME: path.join(tempDir, "data-home"),
};
// The plugin's paths resolve from the process environment (the same ambient
// resolution the CLI and the desktop use), so the fixture env must be live.
Object.assign(process.env, env);
const configDir = path.join(tempDir, "cadet");
const lockfilePath = path.join(tempDir, "cadet", "lockfile.json");

// Capture the plugin's middleware chain from a fake dev server so requests
// can be dispatched through it without booting Vite.
const middlewares: Connect.NextHandleFunction[] = [];
const plugin = localModePlugin(env);
const configureServer = plugin.configureServer as (server: unknown) => void;
configureServer({
  middlewares: {
    use: (handler: Connect.NextHandleFunction) => {
      middlewares.push(handler);
    },
  },
  config: { root: tempDir },
} as unknown as ViteDevServer);

afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

interface DispatchResult {
  status: number;
  body: string;
}

/** Drive a request through the captured connect chain (loopback by default). */
function dispatch(
  url: string,
  headers: Record<string, string> = {},
  options: { method?: string; body?: unknown; remoteAddress?: string } = {},
): Promise<DispatchResult> {
  const { method = "GET", body, remoteAddress = "127.0.0.1" } = options;
  return new Promise((resolve, reject) => {
    const emitter = new EventEmitter();
    const req = Object.assign(emitter, {
      url,
      method,
      headers: { host: "127.0.0.1:5173", ...headers },
      socket: { remoteAddress },
      // The gateway proxy pipes the request into its upstream hop; a GET
      // carries no body, so the pipe just closes the hop.
      pipe: (dest: { end: () => void }) => {
        dest.end();
        return dest;
      },
    }) as unknown as Connect.IncomingMessage;
    const chunks: unknown[] = [];
    const res = Object.assign(new EventEmitter(), {
      statusCode: 200,
      setHeader: () => {},
      writeHead: (status: number) => {
        res.statusCode = status;
      },
      write: (chunk: unknown) => {
        chunks.push(chunk);
      },
      end: (body?: unknown) => {
        if (body != null) {
          chunks.push(body);
        }
        resolve({
          status: res.statusCode,
          body: String(body ?? chunks.join("")),
        });
      },
    }) as unknown as Connect.ServerResponse;
    let index = 0;
    const next = (err?: unknown): void => {
      if (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      const middleware = middlewares[index++];
      if (!middleware) {
        resolve({ status: 404, body: "" });
        return;
      }
      middleware(req, res as unknown as Parameters<typeof middleware>[1], next);
    };
    next();
    if (method === "POST") {
      // Body listeners are registered synchronously by the matched middleware;
      // feed the stream on the next tick.
      setImmediate(() => {
        if (body !== undefined) {
          emitter.emit("data", Buffer.from(JSON.stringify(body)));
        }
        emitter.emit("end");
      });
    }
  });
}

const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 60_000).toISOString();

function writeToken(assistantId: string, over: Record<string, unknown>): void {
  const tokenPath = guardianTokenPath(assistantId);
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fs.writeFileSync(
    tokenPath,
    JSON.stringify({
      guardianPrincipalId: "principal",
      accessToken: "stored-token",
      accessTokenExpiresAt: FUTURE,
      refreshToken: "refresh",
      refreshTokenExpiresAt: FUTURE,
      refreshAfter: FUTURE,
      isNew: false,
      deviceId: "device",
      leasedAt: new Date().toISOString(),
      ...over,
    }),
  );
}

function writeLockfile(assistants: Array<Record<string, unknown>>): void {
  fs.mkdirSync(path.dirname(lockfilePath), { recursive: true });
  fs.writeFileSync(
    lockfilePath,
    JSON.stringify({ assistants, activeAssistant: null }),
  );
}

describe("paired gateway proxy", () => {
  beforeEach(() => {
    fs.rmSync(lockfilePath, { force: true });
    fs.rmSync(path.join(configDir, "assistants"), {
      recursive: true,
      force: true,
    });
  });

  test("rejects a browser request without positive same-origin proof", async () => {
    writeLockfile([
      {
        assistantId: "paired-g",
        cloud: "custom",
        ipAddress: "gateway.example.com",
        port: 443,
      },
    ]);
    writeToken("paired-g", {
      pairedGatewayUrl: "https://gateway.example.com",
    });

    const result = await dispatch("/v1/assistants/paired-g/readyz");

    expect(result).toEqual({ status: 403, body: "Forbidden" });
  });

  test("rejects a browser request from another loopback origin", async () => {
    writeLockfile([
      {
        assistantId: "paired-g",
        cloud: "custom",
        ipAddress: "gateway.example.com",
        port: 443,
      },
    ]);
    writeToken("paired-g", {
      pairedGatewayUrl: "https://gateway.example.com",
    });

    const result = await dispatch("/v1/assistants/paired-g/readyz", {
      origin: "http://127.0.0.1:9999",
      "sec-fetch-site": "same-site",
    });

    expect(result).toEqual({ status: 403, body: "Forbidden" });
  });

  test("pipes a loopback forward with the host-minted bearer injected", async () => {
    // A real loopback upstream: the middleware mints against its /auth/token
    // (leasing the guardian token from the seeded token file), injects the
    // minted bearer on the forward, and the renderer's own authorization
    // never crosses.
    const server = http.createServer((upstreamReq, upstreamRes) => {
      const url = new URL(upstreamReq.url ?? "/", "http://127.0.0.1");
      upstreamRes.writeHead(200, {
        "content-type": "application/json",
        // bun test's fetch enforces CORS on the Origin-carrying mint (the
        // runtime's own gateway does too, for web origins).
        "access-control-allow-origin": "*",
      });
      if (url.pathname === "/auth/token") {
        upstreamRes.end(
          JSON.stringify({
            token: "minted-by-host",
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
          }),
        );
        return;
      }
      upstreamRes.end(
        JSON.stringify({ authorization: upstreamReq.headers.authorization }),
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    try {
      writeLockfile([
        {
          assistantId: "local-a",
          cloud: "local",
          resources: {
            instanceDir: path.join(tempDir, "instances", "local-a"),
            gatewayPort: port,
            daemonPort: 9001,
          },
        },
      ]);
      writeToken("local-a", {});

      const result = await dispatch("/v1/assistants/local-a/conversations", {
        authorization: "Bearer renderer-should-not-send",
      });

      expect(result.status).toBe(200);
      const upstream = JSON.parse(result.body);
      expect(upstream.authorization).toBe("Bearer minted-by-host");
    } finally {
      server.close();
    }
  });
});

describe("devices middleware", () => {
  beforeEach(() => {
    devicesListResult = { ok: true, devices: [] };
    devicesRevokeResult = { ok: true };
    runDevicesListMock.mockClear();
    runDevicesRevokeMock.mockClear();
  });

  const DEVICE = {
    hashedDeviceId: "hash-a",
    platform: "ios",
    issuedAt: 1700000000000,
    expiresAt: null,
    lastUsedAt: null,
  };

  describe("list endpoint", () => {
    test("rejects non-loopback callers", async () => {
      const result = await dispatch(
        "/v1/devices",
        {},
        {
          method: "POST",
          body: { assistantId: "asst-1" },
          remoteAddress: "192.168.1.20",
        },
      );

      expect(result.status).toBe(403);
      expect(runDevicesListMock).not.toHaveBeenCalled();
    });

    test("rejects non-POST methods", async () => {
      const result = await dispatch("/v1/devices");

      expect(result.status).toBe(405);
      expect(runDevicesListMock).not.toHaveBeenCalled();
    });

    test("400 when assistantId is missing", async () => {
      const result = await dispatch(
        "/v1/devices",
        {},
        {
          method: "POST",
          body: {},
        },
      );

      expect(result.status).toBe(400);
      expect(JSON.parse(result.body)).toEqual({
        ok: false,
        error: "Missing assistantId",
      });
    });

    test("passes the device list through", async () => {
      devicesListResult = { ok: true, devices: [DEVICE] };

      const result = await dispatch(
        "/v1/devices",
        {},
        {
          method: "POST",
          body: { assistantId: "asst-1" },
        },
      );

      expect(result.status).toBe(200);
      expect(JSON.parse(result.body)).toEqual({ ok: true, devices: [DEVICE] });
      expect(runDevicesListMock).toHaveBeenCalledWith("asst-1");
    });

    test("run-helper failure yields ok:false with no status field", async () => {
      devicesListResult = { ok: false, error: "gateway offline" };

      const result = await dispatch(
        "/v1/devices",
        {},
        {
          method: "POST",
          body: { assistantId: "asst-1" },
        },
      );

      expect(result.status).toBe(200);
      expect(JSON.parse(result.body)).toEqual({
        ok: false,
        error: "gateway offline",
      });
    });
  });

  describe("revoke endpoint", () => {
    test("rejects non-loopback callers", async () => {
      const result = await dispatch(
        "/v1/devices/revoke",
        {},
        {
          method: "POST",
          body: { assistantId: "asst-1", hashedDeviceId: "hash-a" },
          remoteAddress: "192.168.1.20",
        },
      );

      expect(result.status).toBe(403);
      expect(runDevicesRevokeMock).not.toHaveBeenCalled();
    });

    test("rejects non-POST methods", async () => {
      const result = await dispatch("/v1/devices/revoke");

      expect(result.status).toBe(405);
      expect(runDevicesRevokeMock).not.toHaveBeenCalled();
    });

    test("400 when assistantId is missing", async () => {
      const result = await dispatch(
        "/v1/devices/revoke",
        {},
        {
          method: "POST",
          body: { hashedDeviceId: "hash-a" },
        },
      );

      expect(result.status).toBe(400);
      expect(JSON.parse(result.body)).toEqual({
        ok: false,
        error: "Missing assistantId",
      });
    });

    test("400 when hashedDeviceId is missing", async () => {
      const result = await dispatch(
        "/v1/devices/revoke",
        {},
        {
          method: "POST",
          body: { assistantId: "asst-1" },
        },
      );

      expect(result.status).toBe(400);
      expect(JSON.parse(result.body)).toEqual({
        ok: false,
        error: "Missing hashedDeviceId",
      });
    });

    test("passes a successful revoke through", async () => {
      const result = await dispatch(
        "/v1/devices/revoke",
        {},
        {
          method: "POST",
          body: { assistantId: "asst-1", hashedDeviceId: "hash-a" },
        },
      );

      expect(result.status).toBe(200);
      expect(JSON.parse(result.body)).toEqual({ ok: true });
      expect(runDevicesRevokeMock).toHaveBeenCalledWith("asst-1", "hash-a");
    });

    test("run-helper failure yields ok:false with no status field", async () => {
      devicesRevokeResult = { ok: false, error: "revoke failed" };

      const result = await dispatch(
        "/v1/devices/revoke",
        {},
        {
          method: "POST",
          body: { assistantId: "asst-1", hashedDeviceId: "hash-a" },
        },
      );

      expect(result.status).toBe(200);
      expect(JSON.parse(result.body)).toEqual({
        ok: false,
        error: "revoke failed",
      });
    });
  });
});

describe("operator middleware — the scoped surface's retire arm", () => {
  beforeEach(() => {
    fs.rmSync(lockfilePath, { force: true });
    fs.rmSync(path.join(configDir, "dock-display-name"), {
      recursive: true,
      force: true,
    });
  });

  test("an on-machine entry's retire DELETE runs the headless operation in-process", async () => {
    const instanceDir = path.join(tempDir, "instance-asst-1");
    fs.mkdirSync(instanceDir, { recursive: true });
    writeLockfile([
      {
        assistantId: "asst-1",
        cloud: "local",
        port: 7830,
        instanceDir,
      },
    ]);

    const result = await dispatch(
      "/v1/assistants/asst-1/retire/",
      { origin: "http://127.0.0.1:5173", "sec-fetch-site": "same-origin" },
      { method: "DELETE" },
    );

    // The operation ran against the sandboxed fixture: nothing to stop or
    // archive, the entry removed, a bodyless 204 for the bundle's null.
    expect(result.status).toBe(204);
    const lockfile = JSON.parse(fs.readFileSync(lockfilePath, "utf-8")) as {
      assistants: unknown[];
    };
    expect(lockfile.assistants).toEqual([]);
  });

  test("a cross-origin retire DELETE is refused before the operation runs", async () => {
    writeLockfile([{ assistantId: "asst-1", cloud: "local", port: 7830 }]);

    const result = await dispatch(
      "/v1/assistants/asst-1/retire/",
      { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
      { method: "DELETE" },
    );

    expect(result.status).toBe(403);
    const lockfile = JSON.parse(fs.readFileSync(lockfilePath, "utf-8")) as {
      assistants: unknown[];
    };
    expect(lockfile.assistants).toHaveLength(1);
  });

  test("a platform-hosted entry's retire passes through to the cloud forward", async () => {
    writeLockfile([{ assistantId: "asst-cloud", cloud: "cloud" }]);

    const result = await dispatch(
      "/v1/assistants/asst-cloud/retire/",
      { origin: "http://127.0.0.1:5173", "sec-fetch-site": "same-origin" },
      { method: "DELETE" },
    );

    // Not this host's to retire: the operator route passes, the gateway
    // proxy passes (cloud entries ride the platform session), and the dev
    // `/v1` proxy answers — the end of this chain is a 404.
    expect(result.status).toBe(404);
  });
});
