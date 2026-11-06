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
  async (_input: string | URL, _init?: RequestInit): Promise<Response> =>
    new Response(null, { status: 204 }),
);
const checkHealthMock = mock(
  async (
    _entry: unknown,
    _opts?: { signal?: AbortSignal; headers?: unknown },
  ): Promise<{
    version?: string;
    authenticated: boolean;
  }> => ({ version: undefined, authenticated: true }),
);

mock.module("../loopback-fetch", () => ({
  ...realLoopbackFetch,
  loopbackSafeFetch: loopbackSafeFetchMock,
}));
mock.module("../daemon-readiness", () => ({
  ...realDaemonReadiness,
  checkHealth: checkHealthMock,
}));

// Restore the real modules once this file finishes so the mocks above do not
// leak into other test files in the same `bun test` run.
afterAll(() => {
  mock.module("../loopback-fetch", () => realLoopbackFetch);
  mock.module("../daemon-readiness", () => realDaemonReadiness);
});

import { readLockfile } from "../lockfile";
import { OPERATOR_ROUTES, matchOperatorRequest } from "../operations/routes";

let tmpDir: string;
let lockfilePath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cadet-resolution-op-"));
  lockfilePath = path.join(tmpDir, "cadet", "lockfile.json");
  process.env.XDG_CONFIG_HOME = tmpDir;
  delete process.env.CADET_PLATFORM_TOKEN;
  delete process.env.CADET_CLOUD_TOKEN;
  for (const m of [loopbackSafeFetchMock, checkHealthMock]) {
    m.mockReset();
  }
  loopbackSafeFetchMock.mockResolvedValue(new Response(null, { status: 204 }));
  checkHealthMock.mockResolvedValue({
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

const sentHeaders = (): Headers => {
  const forwarded = checkHealthMock.mock.calls[0]?.[1]?.headers;
  if (!(forwarded instanceof Headers)) {
    throw new Error("the resolution did not forward a Headers instance");
  }
  return forwarded;
};

let callerHeaders: Headers;

const runResolution = async (
  headers: Record<string, string> = {},
  requestPath = "/v1/assistant",
): Promise<Response> => {
  const match = matchOperatorRequest(requestPath, "GET");
  if (!match) throw new Error("the resolution row did not match");
  callerHeaders = new Headers(headers);
  return (await match.route.run({
    assistantId: match.assistantId,
    headers: callerHeaders,
  }))!;
};

const resolutionBody = async (response: Response): Promise<unknown> =>
  (await response.json()) as unknown;

describe("matchOperatorRequest — the four prefixes", () => {
  test("the resolution answers every assistant-reference spelling", () => {
    for (const requestPath of [
      "/v1/assistant",
      "/v1/assistant/",
      "/api/assistant",
      "/assistant",
      "/assistant/",
      "/v1/assistants/a1",
      "/v1/assistants/a1/",
      "/api/assistants/a1",
      "/assistants/a1",
      "/assistants/a1/",
    ]) {
      expect(matchOperatorRequest(requestPath, "GET")).not.toBeNull();
    }
  });

  test("a scoped match carries the decoded id; an unscoped one names the active entry", () => {
    writeLockfile({
      assistants: [
        { assistantId: "a1", cloud: "local", port: 7830 },
        { assistantId: "a2", cloud: "local", port: 7831 },
      ],
      activeAssistant: "a2",
    });
    expect(matchOperatorRequest("/v1/assistants/a1/", "GET")?.assistantId).toBe(
      "a1",
    );
    // Unscoped: the operator backend's active assistant, from the lockfile.
    expect(matchOperatorRequest("/v1/assistant", "GET")?.assistantId).toBe(
      "a2",
    );
  });

  test("does not match other methods or foreign tails", () => {
    expect(matchOperatorRequest("/v1/assistant", "POST")).toBeNull();
    expect(matchOperatorRequest("/v1/assistant", "DELETE")).toBeNull();
    expect(matchOperatorRequest("/v1/assistant/meta", "GET")).toBeNull();
    expect(matchOperatorRequest("/v1/assistant/meta", "DELETE")).toBeNull();
  });

  test("the derivation helpers give every row both spellings", () => {
    for (const route of OPERATOR_ROUTES) {
      const derived = route.pattern.source;
      if (derived.includes("(?<id>")) {
        // An assistant row: helper 2's id capture plus helper 1's
        // optional version arm.
        expect(derived).toContain("(?:\\/v1|\\/api)?");
        expect(derived).toContain("|\\/assistant");
      } else {
        // An absolute row: helper 1's optional version arm, no scoping.
        expect(derived).toContain("(?:\\/v1|\\/api)?");
        expect(derived).not.toContain("(?<id>");
      }
    }
  });
});

describe("runResolveRoute — the lockfile arms", () => {
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
    checkHealthMock.mockResolvedValue({
      version: "0.13.0",
      authenticated: true,
    });

    const response = await runResolution({
      cookie: "cadet_web_access=tok",
    });

    expect(response.status).toBe(200);
    expect(await resolutionBody(response)).toEqual({
      status: "ready",
      assistant: { id: "a1", version: "0.13.0" },
    });
    // The health read rides the ENTRY (the gateway url is resolved inside),
    // and the caller's credential headers are forwarded so the verdict is
    // the caller's.
    // The caller's headers ride VERBATIM — the instance the caller sent,
    // no flattening in between.
    expect(sentHeaders()).toBe(callerHeaders);
    expect(callerHeaders.get("cookie")).toBe("cadet_web_access=tok");
  });

  test("an explicit id resolves that entry even when another is active", async () => {
    writeLockfile({
      assistants: [
        { assistantId: "a1", cloud: "local", port: 7830 },
        { assistantId: "a2", cloud: "local", port: 7831 },
      ],
      activeAssistant: "a2",
    });
    checkHealthMock.mockResolvedValue({
      version: "1.4.0",
      authenticated: true,
    });

    const response = await runResolution({}, "/v1/assistants/a1/");

    expect(await resolutionBody(response)).toEqual({
      status: "ready",
      assistant: { id: "a1", version: "1.4.0" },
    });
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
    expect(checkHealthMock).not.toHaveBeenCalled();
  });

  test("a health read with no verdict and no version answers notReady", async () => {
    writeLockfile({
      assistants: [{ assistantId: "a1", cloud: "local", port: 7830 }],
      activeAssistant: null,
    });
    checkHealthMock.mockResolvedValue({
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
    checkHealthMock.mockResolvedValue({
      version: "0.13.0",
      authenticated: false,
    });

    const response = await runResolution();

    expect(response.status).toBe(401);
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

    expect(sentHeaders()).toBe(callerHeaders);
    expect([...callerHeaders]).toEqual([]);
  });

  test("an id the lockfile does not know passes (null)", async () => {
    writeLockfile({
      assistants: [{ assistantId: "a1", cloud: "local", port: 7830 }],
      activeAssistant: null,
    });

    const response = await runResolution({}, "/v1/assistants/ghost/");

    expect(response).toBeNull();
  });
});

describe("runResolveRoute — the cloud leg", () => {
  test("a cloud entry resolves through the same remote-agnostic health read", async () => {
    writeLockfile({
      assistants: [{ assistantId: "c1", cloud: "cloud" }],
      activeAssistant: null,
    });
    checkHealthMock.mockResolvedValue({
      version: "9.9.9",
      authenticated: true,
    });

    const response = await runResolution({
      cookie: "session=abc",
      authorization: "Bearer tok",
    });

    expect(response.status).toBe(200);
    expect(await resolutionBody(response)).toEqual({
      status: "ready",
      assistant: { id: "c1", version: "9.9.9" },
    });
    // The health read rides the ENTRY — the platform's own gateway address
    // is resolved inside, the caller's credential headers forwarded so the
    // verdict is the caller's.
    // The caller's headers ride VERBATIM — the instance the caller sent,
    // no flattening in between.
    expect(sentHeaders()).toBe(callerHeaders);
    expect(callerHeaders.get("cookie")).toBe("session=abc");
    expect(callerHeaders.get("authorization")).toBe("Bearer tok");
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
