import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Snapshot the real modules before mocking so the module-scoped `afterAll`
// below can restore them — bun runs every test file in one process with a
// shared loader, and `mock.restore()` does not undo `mock.module()`.
const realLoopbackFetch = { ...(await import("../loopback-fetch")) };
const realDaemonReadiness = { ...(await import("../daemon-readiness")) };

const loopbackSafeFetchMock = mock(
  async (
    _input: string | URL,
    _init?: RequestInit,
  ): Promise<Response> => new Response(null, { status: 204 }),
);
const getGatewayHealthMock = mock(async (): Promise<{
  version?: string;
  authenticated: boolean;
}> => ({ version: undefined, authenticated: true }));

mock.module("../loopback-fetch", () => ({
  ...realLoopbackFetch,
  loopbackSafeFetch: loopbackSafeFetchMock,
}));
mock.module("../daemon-readiness", () => ({
  ...realDaemonReadiness,
  getGatewayHealth: getGatewayHealthMock,
}));

// Restore the real modules once this file finishes so the mocks above do not
// leak into other test files in the same `bun test` run.
afterAll(() => {
  mock.module("../loopback-fetch", () => realLoopbackFetch);
  mock.module("../daemon-readiness", () => realDaemonReadiness);
});

import { readLockfile } from "../lockfile";
import { matchOperatorRequest } from "../operations/routes";

let tmpDir: string;
let lockfilePath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cadet-resolution-op-"));
  lockfilePath = path.join(tmpDir, "cadet", "lockfile.json");
  process.env.XDG_CONFIG_HOME = tmpDir;
  delete process.env.CADET_PLATFORM_TOKEN;
  delete process.env.CADET_CLOUD_TOKEN;
  for (const m of [loopbackSafeFetchMock, getGatewayHealthMock]) {
    m.mockReset();
  }
  loopbackSafeFetchMock.mockResolvedValue(
    new Response(null, { status: 204 }),
  );
  getGatewayHealthMock.mockResolvedValue({
    version: undefined,
    authenticated: true,
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const writeLockfile = (data: Record<string, unknown>): void => {
  fs.mkdirSync(path.dirname(lockfilePath), { recursive: true });
  fs.writeFileSync(lockfilePath, JSON.stringify(data));
};

const runResolution = async (
  headers: Record<string, string> = {},
): Promise<Response> => {
  const match = matchOperatorRequest("/v1/assistant", "GET");
  if (!match) throw new Error("the resolution row did not match");
  return (await match.route.run(match.assistantId, new Headers(headers)))!;
};

const resolutionBody = async (response: Response): Promise<unknown> =>
  (await response.json()) as unknown;

describe("matchOperatorRequest — the unscoped resolution row", () => {
  test("matches GET /v1/assistant with and without the trailing slash", () => {
    const bare = matchOperatorRequest("/v1/assistant", "GET");
    expect(bare).not.toBeNull();
    expect(bare?.assistantId).toBe("");
    expect(matchOperatorRequest("/v1/assistant/", "GET")).not.toBeNull();
  });

  test("does not match other methods or the scoped surface", () => {
    expect(matchOperatorRequest("/v1/assistant", "POST")).toBeNull();
    expect(matchOperatorRequest("/v1/assistant", "DELETE")).toBeNull();
    expect(matchOperatorRequest("/v1/assistants/a", "GET")).toBeNull();
    expect(matchOperatorRequest("/v1/assistant/meta", "GET")).toBeNull();
  });
});

describe("runAssistantResolution — the lockfile arms", () => {
  test("an unpaired machine answers empty", async () => {
    const response = await runResolution();
    expect(response.status).toBe(200);
    expect(await resolutionBody(response)).toEqual({ status: "empty" });
  });

  test("the single entry resolves ready through the gateway health read", async () => {
    writeLockfile({
      assistants: [{ assistantId: "a1", cloud: "local", port: 7830 }],
      activeAssistant: null,
    });
    getGatewayHealthMock.mockResolvedValue({
      version: "0.13.0",
      authenticated: true,
    });

    const response = await runResolution({
      cookie: "cadet_web_access=tok",
    });

    expect(response.status).toBe(200);
    expect(await resolutionBody(response)).toEqual({
      status: "ready",
      assistant: { id: "a1", version: "0.13.0", url: "assistant/" },
    });
    // The health read rides the entry's own gateway, and the caller's
    // credential headers are forwarded so the verdict is the caller's.
    expect(getGatewayHealthMock).toHaveBeenCalledWith(
      "http://127.0.0.1:7830",
      { headers: { cookie: "cadet_web_access=tok" } },
    );
  });

  test("the active entry wins when several are recorded", async () => {
    writeLockfile({
      assistants: [
        { assistantId: "a1", cloud: "local", port: 7830 },
        { assistantId: "a2", cloud: "local", port: 7831 },
      ],
      activeAssistant: "a2",
    });
    getGatewayHealthMock.mockResolvedValue({
      version: "0.13.0",
      authenticated: true,
    });

    const response = await runResolution();

    expect(await resolutionBody(response)).toEqual({
      status: "ready",
      assistant: { id: "a2", version: "0.13.0", url: "assistant/" },
    });
    expect(getGatewayHealthMock).toHaveBeenCalledWith(
      "http://127.0.0.1:7831",
      expect.anything(),
    );
  });

  test("several entries and no active pointer hand off to the chooser", async () => {
    writeLockfile({
      assistants: [
        { assistantId: "a1", cloud: "local", port: 7830, name: "One" },
        { assistantId: "a2", cloud: "docker", port: 7831 },
      ],
      activeAssistant: null,
    });

    const response = await runResolution();

    expect(response.status).toBe(200);
    expect(await resolutionBody(response)).toEqual({
      status: "selection",
      assistants: [
        { id: "a1", name: "One", remote: "local" },
        { id: "a2", remote: "docker" },
      ],
    });
    expect(getGatewayHealthMock).not.toHaveBeenCalled();
  });

  test("a health read with no verdict and no version answers notReady", async () => {
    writeLockfile({
      assistants: [{ assistantId: "a1", cloud: "local", port: 7830 }],
      activeAssistant: null,
    });
    getGatewayHealthMock.mockResolvedValue({
      version: undefined,
      authenticated: true,
    });

    const response = await runResolution();

    expect(await resolutionBody(response)).toEqual({ status: "notReady" });
  });

  test("a rejected verdict answers unauthenticated", async () => {
    writeLockfile({
      assistants: [{ assistantId: "a1", cloud: "local", port: 7830 }],
      activeAssistant: null,
    });
    getGatewayHealthMock.mockResolvedValue({
      version: "0.13.0",
      authenticated: false,
    });

    const response = await runResolution();

    expect(await resolutionBody(response)).toEqual({
      status: "unauthenticated",
    });
  });

  test("requests without credentials forward no credential headers", async () => {
    writeLockfile({
      assistants: [{ assistantId: "a1", cloud: "local", port: 7830 }],
      activeAssistant: null,
    });

    await runResolution();

    expect(getGatewayHealthMock).toHaveBeenCalledWith(
      "http://127.0.0.1:7830",
      { headers: {} },
    );
  });
});

describe("runAssistantResolution — the cloud leg", () => {
  test("a cloud entry resolves through the platform's own detail", async () => {
    writeLockfile({
      assistants: [{ assistantId: "c1", cloud: "cloud" }],
      activeAssistant: null,
    });
    loopbackSafeFetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "active",
          id: "c1",
          version: "9.9.9",
          url: "https://platform.example.test/c1/assistant/",
        }),
        { status: 200 },
      ),
    );

    const response = await runResolution({
      cookie: "session=abc",
      authorization: "Bearer tok",
    });

    expect(response.status).toBe(200);
    expect(await resolutionBody(response)).toEqual({
      status: "ready",
      assistant: {
        id: "c1",
        version: "9.9.9",
        url: "https://platform.example.test/c1/assistant/",
      },
    });
    const [fetchedUrl, init] = loopbackSafeFetchMock.mock.calls[0]!;
    expect(String(fetchedUrl)).toContain("/v1/assistants/c1/");
    const requestHeaders = new Headers(init?.headers as HeadersInit);
    expect(requestHeaders.get("cookie")).toBe("session=abc");
    expect(requestHeaders.get("authorization")).toBe("Bearer tok");
    expect(getGatewayHealthMock).not.toHaveBeenCalled();
  });

  test("the platform's status codes carry the arms", async () => {
    writeLockfile({
      assistants: [{ assistantId: "c1", cloud: "cloud" }],
      activeAssistant: null,
    });
    for (const [status, expected] of [
      [401, { status: "unauthenticated" }],
      [409, { status: "notReady" }],
      [410, { status: "unavailable" }],
    ] as const) {
      loopbackSafeFetchMock.mockResolvedValue(
        new Response(null, { status }),
      );
      const response = await runResolution();
      expect(await resolutionBody(response)).toEqual(expected);
    }
  });

  test("a platform failure degrades to notReady rather than throwing", async () => {
    writeLockfile({
      assistants: [{ assistantId: "c1", cloud: "cloud" }],
      activeAssistant: null,
    });
    loopbackSafeFetchMock.mockRejectedValue(new Error("down"));

    const response = await runResolution();

    expect(await resolutionBody(response)).toEqual({ status: "notReady" });
  });

  test("a malformed detail body degrades to notReady", async () => {
    writeLockfile({
      assistants: [{ assistantId: "c1", cloud: "cloud" }],
      activeAssistant: null,
    });
    loopbackSafeFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ status: "active" }), { status: 200 }),
    );

    const response = await runResolution();

    expect(await resolutionBody(response)).toEqual({ status: "notReady" });
  });
});

describe("the lockfile is untouched by resolution", () => {
  test("the read-only operation leaves the registry as it found it", async () => {
    writeLockfile({
      assistants: [{ assistantId: "a1", cloud: "local", port: 7830 }],
      activeAssistant: null,
    });

    await runResolution();

    expect(readLockfile().assistants).toHaveLength(1);
  });
});
