import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Self-contained by design: no module-level mocks. The suite's other files
// mock shared modules (cloud-auth, loopback-fetch, the lookup) through bun's
// process-wide registry, and that registry is order-sensitive enough that
// one more mock.module-ing file here broke unrelated wake/sleep suites in
// CI. Everything this row needs is drivable through the real modules: a
// seeded lockfile resolves the entry, the env token authenticates the
// operator, the env cloud URL points the hop, and the HTTP boundary is the
// one thing faked — the global fetch, restored after every test.
const { matchOperatorRequest } = await import("../operations/routes");

const ENTRY = {
  assistantId: "test-assistant",
  cloud: "local",
  cloudOrganizationId: "org-123",
};

const CLOUD_URL = "https://test-cloud.mycadet.ai";

let tmpDir: string;
let realFetch: typeof fetch;
let realXdg: string | undefined;
let fetchCalls: Array<{ url: string; init: RequestInit }> = [];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cadet-migrations-op-"));
  realXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tmpDir;
  fs.mkdirSync(path.join(tmpDir, "cadet"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, "cadet", "lockfile.json"),
    JSON.stringify({
      assistants: [ENTRY],
      activeAssistant: ENTRY.assistantId,
    }),
  );
  process.env.CADET_CLOUD_TOKEN = "operator-token";
  process.env.CADET_CLOUD_URL = CLOUD_URL;

  realFetch = globalThis.fetch;
  fetchCalls = [];
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    fetchCalls.push({
      url: String(input),
      init: (init ?? {}) as RequestInit,
    });
    return new Response(
      JSON.stringify({
        url: "https://storage.example/download",
        bundle_key: "bundle-1",
        expires_at: "2026-11-10T18:00:00Z",
      }),
      { status: 201 },
    );
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.CADET_CLOUD_TOKEN;
  delete process.env.CADET_CLOUD_URL;
  if (realXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = realXdg;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

async function dial(
  method: string,
  path: string,
  init?: { headers?: Record<string, string>; body?: string },
): Promise<Response | null> {
  const match = matchOperatorRequest(path, method);
  if (!match) return null;
  return match.route.run({
    assistantId: match.assistantId,
    method,
    path,
    headers: new Headers(init?.headers),
    body: init?.body ? new Blob([init.body]).stream() : null,
  });
}

describe("the migrations operator row", () => {
  test("the signed-url dial hops to the cloud on the operator's credentials", async () => {
    const res = await dial(
      "POST",
      `/v1/assistants/${ENTRY.assistantId}/migrations/signed-url/`,
      {
        body: JSON.stringify({
          operation: "download",
          bundle_key: "bundle-1",
        }),
      },
    );
    expect(res?.status).toBe(201);
    await res?.json();

    expect(fetchCalls.length).toBe(1);
    // The cloud's dial is not assistant-addressed — the entry only
    // contributes the organization header.
    expect(fetchCalls[0].url).toBe(`${CLOUD_URL}/v1/migrations/signed-url/`);
    const headers = fetchCalls[0].init.headers as Record<string, string>;
    expect(headers["X-Session-Token"]).toBe("operator-token");
    expect(headers["Cadet-Organization-Id"]).toBe("org-123");
    expect(fetchCalls[0].init.body).toBe(
      JSON.stringify({ operation: "download", bundle_key: "bundle-1" }),
    );
    // The non-streaming rows ride the fixed upstream timeout.
    expect(fetchCalls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  test("an operator with no cloud token answers 401", async () => {
    delete process.env.CADET_CLOUD_TOKEN;

    const res = await dial(
      "POST",
      `/v1/assistants/${ENTRY.assistantId}/migrations/signed-url/`,
      { body: "{}" },
    );
    expect(res?.status).toBe(401);
    expect(fetchCalls.length).toBe(0);
  });

  test("an unknown assistant leaves the row unmatched", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "cadet", "lockfile.json"),
      JSON.stringify({ assistants: [], activeAssistant: null }),
    );

    const res = await dial(
      "POST",
      "/v1/assistants/who-is-this/migrations/signed-url/",
      { body: "{}" },
    );
    expect(res).toBeNull();
  });

  test("an unreachable cloud answers 502 with the body shape the web reads", async () => {
    globalThis.fetch = (async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;

    const res = await dial(
      "POST",
      `/v1/assistants/${ENTRY.assistantId}/migrations/signed-url/`,
      { body: "{}" },
    );
    expect(res?.status).toBe(502);
    const body = (await res?.json()) as { detail?: string };
    expect(body.detail).toContain("Cadet Cloud");
  });
});
