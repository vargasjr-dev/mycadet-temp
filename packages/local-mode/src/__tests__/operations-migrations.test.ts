import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

// Snapshot the real modules before mocking so the module-scoped `afterAll`
// below can restore them — bun runs every test file in one process with a
// shared loader, and `mock.restore()` does not undo `mock.module()`.
const realCloudAuth = { ...(await import("../cloud-auth")) };
const realLoopbackFetch = { ...(await import("../loopback-fetch")) };
const realLookup = { ...(await import("../operations/lookup")) };

const fetchMock = mock<
  (url: string | URL | Request, init?: RequestInit) => Promise<Response>
>(async () => new Response());

mock.module("../loopback-fetch", () => ({
  ...realLoopbackFetch,
  loopbackSafeFetch: (...args: Parameters<typeof fetch>) => fetchMock(...args),
}));

let credentialState: {
  token: string | null;
  cloudUrl: string;
} = { token: null, cloudUrl: "https://test-cloud.mycadet.ai" };

mock.module("../cloud-auth", () => ({
  ...realCloudAuth,
  readCloudToken: () => credentialState.token,
  resolveCloudUrl: () => credentialState.cloudUrl,
  authHeadersForKnownOrganization: (token: string, organizationId: string) => ({
    "X-Session-Token": token,
    "Cadet-Organization-Id": organizationId,
  }),
}));

const ENTRY = {
  assistantId: "test-assistant",
  cloud: "local",
  cloudAssistantId: "33333333-3333-4333-8333-333333333333",
  cloudOrganizationId: "org-123",
};

mock.module("../operations/lookup", () => ({
  ...realLookup,
  findAssistantByName: (name: string) =>
    name === ENTRY.assistantId ? ENTRY : null,
}));

const { matchOperatorRequest } = await import("../operations/routes");

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
  beforeEach(() => {
    credentialState = {
      token: "operator-token",
      cloudUrl: "https://test-cloud.mycadet.ai",
    };
  });

  afterAll(() => {
    mock.module("../cloud-auth", () => realCloudAuth);
    mock.module("../loopback-fetch", () => realLoopbackFetch);
    mock.module("../operations/lookup", () => realLookup);
  });

  afterEach(() => {
    fetchMock.mockReset();
  });

  test("the signed-url dial hops to the cloud on the operator's credentials", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            url: "https://storage.example/download",
            bundle_key: "bundle-1",
            expires_at: "2026-11-10T18:00:00Z",
          }),
          { status: 201 },
        ),
    );

    const res = await dial(
      "POST",
      `/v1/assistants/${ENTRY.assistantId}/migrations/signed-url/`,
      { body: JSON.stringify({ operation: "download", bundle_key: "bundle-1" }) },
    );
    expect(res?.status).toBe(201);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    // The cloud's dial is not assistant-addressed — the entry only
    // contributes the organization header.
    expect(url).toBe("https://test-cloud.mycadet.ai/v1/migrations/signed-url/");
    expect((init.headers as Record<string, string>)["X-Session-Token"]).toBe(
      "operator-token",
    );
    expect(
      (init.headers as Record<string, string>)["Cadet-Organization-Id"],
    ).toBe("org-123");
    expect(init.body).toBe(
      JSON.stringify({ operation: "download", bundle_key: "bundle-1" }),
    );
    // The non-streaming rows ride the fixed upstream timeout.
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  test("an operator with no cloud token answers 401", async () => {
    credentialState = { ...credentialState, token: null };

    const res = await dial(
      "POST",
      `/v1/assistants/${ENTRY.assistantId}/migrations/signed-url/`,
      { body: "{}" },
    );
    expect(res?.status).toBe(401);
    expect(fetchMock.mock.calls.length).toBe(0);
  });

  test("an unknown assistant leaves the row unmatched", async () => {
    const res = await dial("POST", "/v1/assistants/who-is-this/migrations/signed-url/", {
      body: "{}",
    });
    expect(res).toBeNull();
  });

  test("an unreachable cloud answers 502 with the body shape the web reads", async () => {
    fetchMock.mockImplementation(async () => {
      throw new Error("boom");
    });

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
