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
import { forwardOperatorRequest, OPERATOR_ROUTES } from "../operations/routes";

/**
 * Dispatches through the real dispatcher — the rows are its internals, so
 * the tests speak the mount's API, not the match/run seam.
 */
const dispatch = (path: string, method = "GET"): Promise<Response | null> =>
  forwardOperatorRequest(
    new Request(`http://operator.test${path}`, { method }),
  );

let tmpDir: string;
let lockfilePath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cadet-resolution-op-"));
  lockfilePath = path.join(tmpDir, "cadet", "lockfile.json");
  process.env.XDG_CONFIG_HOME = tmpDir;
  delete process.env.CADET_CLOUD_TOKEN;
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
  callerHeaders = new Headers(headers);
  const request = new Request(`http://operator.test${requestPath}`, {
    headers: callerHeaders,
  });
  const response = await forwardOperatorRequest(request);
  if (!response) throw new Error("the resolution row did not answer");
  return response;
};

const resolutionBody = async (response: Response): Promise<unknown> =>
  (await response.json()) as unknown;

describe("the dispatcher — the four prefixes", () => {
  test("the resolution answers every versioned assistant-reference spelling", async () => {
    writeLockfile({
      assistants: [{ assistantId: "a1", cloud: "local", port: 7830 }],
      activeAssistant: null,
    });
    for (const requestPath of [
      "/v1/assistant",
      "/v1/assistant/",
      "/api/assistant",
      "/api/assistant/",
      "/v1/assistants/a1",
      "/v1/assistants/a1/",
      "/api/assistants/a1",
      "/api/assistants/a1/",
    ]) {
      expect(await dispatch(requestPath)).not.toBeNull();
    }
    // The bare spellings are gone on purpose: api routes nest under a
    // version prefix, or they collide with the frontend routes.
    for (const requestPath of ["/assistant", "/assistant/", "/assistants/a1"]) {
      expect(await dispatch(requestPath)).toBeNull();
    }
  });

  test("every route answers both trailing-slash spellings", async () => {
    // Helper 1 owns the trailing slash and makes it optional — the bare
    // spellings match the same rows their slashed forms do. The list row
    // previously REQUIRED the slash, so the bare /v1/assistants fell
    // through to the static surface's 404.
    for (const requestPath of ["/v1/assistants", "/v1/assistants/"]) {
      expect(await dispatch(requestPath)).not.toBeNull();
    }
    for (const requestPath of [
      "/v1/devices",
      "/v1/devices/",
      "/v1/remote-web/pairing-start",
      "/v1/remote-web/pairing-start/",
    ]) {
      expect(await dispatch(requestPath, "POST")).not.toBeNull();
    }
  });

  test("a scoped dispatch resolves the named entry; an unscoped one the active entry", async () => {
    writeLockfile({
      assistants: [
        { assistantId: "a1", cloud: "local", port: 7830 },
        { assistantId: "a2", cloud: "local", port: 7831 },
      ],
      activeAssistant: "a2",
    });
    await dispatch("/v1/assistants/a1/");
    expect(
      (checkHealthMock.mock.calls.at(-1)?.[0] as { assistantId: string })
        .assistantId,
    ).toBe("a1");
    // Unscoped: the operator backend's active assistant, from the lockfile.
    await dispatch("/v1/assistant");
    expect(
      (checkHealthMock.mock.calls.at(-1)?.[0] as { assistantId: string })
        .assistantId,
    ).toBe("a2");
  });

  test("the proxy catch-all owns foreign methods and tails", async () => {
    // The bare shared form has no tail for the proxy row's `.+`, so it
    // genuinely passes; anything scoped falls to the ALL proxy row, which
    // dials the matched entry (stubbed here) instead of answering
    // host-side.
    writeLockfile({
      assistants: [{ assistantId: "a1", cloud: "local", port: 7830 }],
      activeAssistant: null,
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = mock(
      async (input: unknown, init?: unknown) => new Response("gateway"),
    ) as unknown as typeof fetch;
    try {
      expect(await dispatch("/v1/assistant", "POST")).toBeNull();
      expect(await dispatch("/v1/assistant", "DELETE")).toBeNull();
      expect(await dispatch("/v1/assistant/meta", "GET")).not.toBeNull();
      expect(await dispatch("/v1/assistant/meta", "DELETE")).not.toBeNull();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("the derivation helpers give every row both versioned spellings", () => {
    for (const route of OPERATOR_ROUTES) {
      const derived = route.pattern.source;
      if (derived.startsWith("^\\/webhooks")) {
        // The channel-webhook row is PUBLIC ingress at the root — external
        // services post fixed URLs (Telegram's registered callback), so no
        // version arm or tail hygiene applies. Pinned exactly so no other
        // row sneaks past the derivation unversioned.
        expect(derived).toBe("^\\/webhooks(?:\\/.*)?$");
        continue;
      }
      if (derived.startsWith("^(?:\\/_allauth")) {
        // The cloud arm's row is the OR-union of the cloud's own
        // prefixes — absolute paths (like the webhook row), no version
        // arm, no tail hygiene. Pinned exactly so no other row sneaks
        // past the derivation unversioned.
        expect(derived).toBe(
          "^(?:\\/_allauth|\\/accounts|\\/v1\\/releases)(?:$|\\/)",
        );
        continue;
      }
      if (derived.includes("(?<id>")) {
        // An assistant row: helper 2's id capture plus helper 1's required
        // version arm. Rows declare relative patterns, so the scoping arm
        // carries no leading slash.
        expect(derived).toContain("(?:\\/v1|\\/api)");
        expect(derived).toContain("|assistant");
      } else {
        // An absolute row: helper 1's required version arm, no scoping.
        expect(derived).toContain("(?:\\/v1|\\/api)");
        expect(derived).not.toContain("(?<id>");
      }
      // Helper 1 owns the slashes: every row ends in the optional trailing
      // one, and none spells a slash of its own.
      expect(derived.endsWith("\\/?$")).toBe(true);
      expect(derived).not.toContain("\\/?$\\/");
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
    // and the caller's credential headers ride so the verdict is the
    // caller's — the dispatcher hands the row its own normalized Headers
    // instance carrying them.
    expect(sentHeaders().get("cookie")).toBe(callerHeaders.get("cookie"));
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

    expect(response.status).toBe(409);
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

    expect(sentHeaders().get("cookie")).toBeNull();
    expect(sentHeaders().get("authorization")).toBeNull();
    expect([...callerHeaders]).toEqual([]);
  });

  test("an id the lockfile does not know answers 404", async () => {
    writeLockfile({
      assistants: [{ assistantId: "a1", cloud: "local", port: 7830 }],
      activeAssistant: null,
    });

    const response = await forwardOperatorRequest(
      new Request("http://operator.test/v1/assistants/ghost/"),
    );

    expect(response?.status).toBe(404);
  });
});

describe("runResolveRoute — the cloud leg", () => {
  test("startup returns welcome when the only saved cloud assistant is unavailable", async () => {
    writeLockfile({
      assistants: [{ assistantId: "c1", cloud: "cloud" }],
      activeAssistant: "c1",
    });
    loopbackSafeFetchMock.mockResolvedValue(
      Response.json({ status: "unavailable" }, { status: 410 }),
    );

    const response = await runResolution({ cookie: "session=abc" });
    expect(response.status).toBe(200);
    expect(await resolutionBody(response)).toEqual({ status: "empty" });
    const [url, init] = loopbackSafeFetchMock.mock.calls[0]!;
    expect(new URL(url).pathname).toBe("/v1/assistants/c1/");
    expect(new Headers(init?.headers).get("cookie")).toBe("session=abc");
    expect(readLockfile().assistants).toHaveLength(1);
  });

  test("startup offers other assistants when the saved cloud assistant is unavailable", async () => {
    writeLockfile({
      assistants: [
        { assistantId: "c1", cloud: "cloud" },
        { assistantId: "a1", cloud: "local", port: 7830 },
      ],
      activeAssistant: "c1",
    });
    loopbackSafeFetchMock.mockImplementation(async () =>
      Response.json({ status: "unavailable" }, { status: 410 }),
    );

    expect(await resolutionBody(await runResolution())).toEqual({
      status: "selection",
      assistants: [{ id: "a1", remote: "local" }],
    });
    const scoped = await runResolution({}, "/v1/assistants/c1/");
    expect(scoped.status).toBe(410);
    expect(await resolutionBody(scoped)).toEqual({ status: "unavailable" });
  });

  test.each([409, 503])("keeps the wake path when cloud lookup returns %i", async (status) => {
    writeLockfile({
      assistants: [{ assistantId: "c1", cloud: "cloud" }],
      activeAssistant: null,
    });
    loopbackSafeFetchMock.mockResolvedValue(new Response(null, { status }));

    const response = await runResolution();
    expect(response.status).toBe(409);
    expect(await resolutionBody(response)).toEqual({ status: "notReady" });
  });

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
    // The health read rides the ENTRY — the cloud base's own address is
    // resolved inside, the caller's credential headers ride so the verdict
    // is the caller's.
    expect(sentHeaders().get("cookie")).toBe(callerHeaders.get("cookie"));
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
