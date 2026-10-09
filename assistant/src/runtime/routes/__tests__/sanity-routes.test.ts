/**
 * Unit tests for sanity-routes.ts.
 *
 * Drives the handler functions directly (bypassing the router) with the real
 * secure-keys memory backend; the sidecar write lands in the preload's real
 * per-process workspace and is asserted by reading the file back. fetch is
 * mocked at the network boundary.
 */

import { readFileSync, rmSync } from "node:fs";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

// ---------------------------------------------------------------------------
// Module mocks — must appear before any imports of the module under test
// ---------------------------------------------------------------------------
import { useMemorySecureKeys } from "../../../__tests__/helpers/secure-keys.js";
import { credentialKey } from "../../../security/credential-key.js";

// The REAL secure-keys module pinned to a live memory backend, seeded under
// the credential key the sanity routes read.
const secureKeys = useMemorySecureKeys();
const SANITY_TOKEN = credentialKey("sanity", "api_token");

// The preload's workspace is where route handlers build their paths.
const WORKSPACE_DIR = process.env.CADET_WORKSPACE_DIR!;
const SIDECAR_PATH = () => `${WORKSPACE_DIR}/data/sanity-connection.json`;

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { ROUTES } from "../sanity-routes.js";
import type { RouteDefinition, RouteHandlerArgs } from "../types.js";

afterAll(() => {
  mock.restore();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findHandler(operationId: string): RouteDefinition["handler"] {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) {
    throw new Error(`Route ${operationId} not found`);
  }
  return route.handler;
}

function makeArgs(body?: Record<string, unknown>): RouteHandlerArgs {
  return { body };
}

const discoverHandler = findHandler("sanity_discover");
const connectHandler = findHandler("sanity_connect");

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------

type FetchReturn = { status: number; json: () => unknown };
let mockFetchImpl: ((url: string) => FetchReturn) | undefined = undefined;

const originalFetch = globalThis.fetch;

function mockFetch(url: string | URL | Request): Promise<Response> {
  const urlStr =
    typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
  if (!mockFetchImpl) {
    throw new Error(`Unexpected fetch: ${urlStr}`);
  }
  const result = mockFetchImpl(urlStr);
  return Promise.resolve({
    ok: result.status >= 200 && result.status < 300,
    status: result.status,
    json: async () => result.json(),
  } as Response);
}

beforeEach(() => {
  // The preload workspace is shared by the whole process; drop any sidecar
  // a previous test wrote.
  rmSync(SIDECAR_PATH(), { force: true });
  delete secureKeys[SANITY_TOKEN];
  mockFetchImpl = undefined;

  (globalThis as any).fetch = mockFetch;
});

afterEach(() => {
  (globalThis as any).fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// POST /v1/sanity/discover — no stored token
// ---------------------------------------------------------------------------

describe("sanity_discover — no stored token", () => {
  test("returns { error: 'no_token' } when token absent", async () => {
    delete secureKeys[SANITY_TOKEN];
    const result = await discoverHandler(makeArgs({}));
    expect(result).toEqual({ error: "no_token" });
  });
});

// ---------------------------------------------------------------------------
// POST /v1/sanity/discover — project listing
// ---------------------------------------------------------------------------

describe("sanity_discover — list projects", () => {
  beforeEach(() => {
    secureKeys[SANITY_TOKEN] = "sk-test-token";
  });

  test("returns projects when API responds 200", async () => {
    mockFetchImpl = () => ({
      status: 200,
      json: () => [
        { id: "proj-a", displayName: "Project Alpha" },
        { id: "proj-b", displayName: "Project Beta" },
      ],
    });

    const result = await discoverHandler(makeArgs({}));
    expect(result).toEqual({
      projects: [
        { id: "proj-a", displayName: "Project Alpha" },
        { id: "proj-b", displayName: "Project Beta" },
      ],
    });
  });

  test("returns { error: 'token_scope_limited' } on 401", async () => {
    mockFetchImpl = () => ({ status: 401, json: () => ({}) });
    const result = await discoverHandler(makeArgs({}));
    expect(result).toEqual({ error: "token_scope_limited" });
  });

  test("returns { error: 'token_scope_limited' } on 403", async () => {
    mockFetchImpl = () => ({ status: 403, json: () => ({}) });
    const result = await discoverHandler(makeArgs({}));
    expect(result).toEqual({ error: "token_scope_limited" });
  });

  test("returns { error: 'discovery_failed' } on 500", async () => {
    mockFetchImpl = () => ({ status: 500, json: () => ({}) });
    const result = await discoverHandler(makeArgs({}));
    expect(result).toEqual({ error: "discovery_failed" });
  });
});

// ---------------------------------------------------------------------------
// POST /v1/sanity/discover — dataset listing (projectId provided)
// ---------------------------------------------------------------------------

describe("sanity_discover — list datasets", () => {
  beforeEach(() => {
    secureKeys[SANITY_TOKEN] = "sk-test-token";
  });

  test("returns datasets when API responds 200", async () => {
    mockFetchImpl = (url) => {
      expect(url).toContain("/projects/my-project/datasets");
      return {
        status: 200,
        json: () => [{ name: "production" }, { name: "staging" }],
      };
    };

    const result = await discoverHandler(makeArgs({ projectId: "my-project" }));
    expect(result).toEqual({
      projectId: "my-project",
      datasets: ["production", "staging"],
    });
  });

  test("returns { error: 'token_scope_limited' } on 403 for dataset list", async () => {
    mockFetchImpl = () => ({ status: 403, json: () => ({}) });
    const result = await discoverHandler(makeArgs({ projectId: "my-project" }));
    expect(result).toEqual({ error: "token_scope_limited" });
  });

  test("returns { error: 'discovery_failed' } on 500 for dataset list", async () => {
    mockFetchImpl = () => ({ status: 500, json: () => ({}) });
    const result = await discoverHandler(makeArgs({ projectId: "my-project" }));
    expect(result).toEqual({ error: "discovery_failed" });
  });
});

// ---------------------------------------------------------------------------
// POST /v1/sanity/connect
// ---------------------------------------------------------------------------

describe("sanity_connect", () => {
  test("writes sidecar when token present and inputs valid", async () => {
    secureKeys[SANITY_TOKEN] = "sk-test-token";

    const result = await connectHandler(
      makeArgs({ projectId: "my-proj", dataset: "production" }),
    );

    expect(result).toEqual({ ok: true });

    const written = JSON.parse(readFileSync(SIDECAR_PATH(), "utf-8"));
    expect(written).toEqual({ projectId: "my-proj", dataset: "production" });
  });

  test("throws when no token is stored", async () => {
    delete secureKeys[SANITY_TOKEN];

    expect(
      connectHandler(makeArgs({ projectId: "p", dataset: "production" })),
    ).rejects.toThrow();
  });

  test("throws when projectId is empty", async () => {
    secureKeys[SANITY_TOKEN] = "sk-test-token";

    expect(
      connectHandler(makeArgs({ projectId: "  ", dataset: "production" })),
    ).rejects.toThrow();
  });

  test("throws when dataset is empty", async () => {
    secureKeys[SANITY_TOKEN] = "sk-test-token";

    expect(
      connectHandler(makeArgs({ projectId: "my-proj", dataset: "" })),
    ).rejects.toThrow();
  });

  test("does not return token in response", async () => {
    secureKeys[SANITY_TOKEN] = "sk-super-secret";

    const result = (await connectHandler(
      makeArgs({ projectId: "p", dataset: "d" }),
    )) as Record<string, unknown>;

    const resultStr = JSON.stringify(result);
    expect(resultStr).not.toContain("sk-super-secret");
  });
});

// ---------------------------------------------------------------------------
// Route policy verification
// ---------------------------------------------------------------------------

describe("route policies", () => {
  test("sanity_discover requires settings.write (secrets-grade)", () => {
    const route = ROUTES.find((r) => r.operationId === "sanity_discover");
    expect(route?.policy?.requiredScopes).toContain("settings.write");
  });

  test("sanity_connect requires settings.write (secrets-grade)", () => {
    const route = ROUTES.find((r) => r.operationId === "sanity_connect");
    expect(route?.policy?.requiredScopes).toContain("settings.write");
  });
});
