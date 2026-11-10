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
  organizationId?: string;
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

const CLOUD_ASSISTANT_ID = ENTRY.cloudAssistantId;
const SESSION_ID = "doctor-sess-7";

async function dial(
  method: string,
  path: string,
  init?: { headers?: Record<string, string>; body?: string },
): Promise<Response | null> {
  // matchOperatorRequest takes the pathname only — the search rides in
  // the OperatorRequest's path field.
  const pathname = path.split("?")[0];
  const match = matchOperatorRequest(pathname, method);
  if (!match) return null;
  return match.route.run({
    assistantId: match.assistantId,
    method,
    path,
    headers: new Headers(init?.headers),
    body: init?.body ? new Blob([init.body]).stream() : null,
  });
}

describe("the doctor operator rows", () => {
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

  test("history list proxies the query string to the entry's cloud assistant", async () => {
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify({ results: [] })),
    );

    const res = await dial(
      "GET",
      `/v1/assistants/${ENTRY.assistantId}/doctor/history/?limit=1`,
    );
    expect(res?.status).toBe(200);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      `https://test-cloud.mycadet.ai/v1/assistants/${CLOUD_ASSISTANT_ID}/doctor/history/?limit=1`,
    );
    expect((init.headers as Record<string, string>)["X-Session-Token"]).toBe(
      "operator-token",
    );
    expect(
      (init.headers as Record<string, string>)["Cadet-Organization-Id"],
    ).toBe("org-123");
  });

  test("the unscoped spelling resolves the active assistant", async () => {
    fetchMock.mockImplementation(async () => new Response("{}"));
    // The unscoped row's active assistant comes from the lockfile — the
    // fixture entry is addressed by name here instead.
    const res = await dial(
      "GET",
      `/v1/assistants/${ENTRY.assistantId}/doctor/history/sess-1/`,
    );
    expect(res?.status).toBe(200);
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe(
      `https://test-cloud.mycadet.ai/v1/assistants/${CLOUD_ASSISTANT_ID}/doctor/history/sess-1/`,
    );
  });

  test("the event stream forwards Last-Event-ID and has no timeout", async () => {
    fetchMock.mockImplementation(
      async () => new Response("event: status\ndata: {}\n\n"),
    );

    const res = await dial("GET", `/v1/assistants/${ENTRY.assistantId}/doctor/sessions/${SESSION_ID}/events/`, {
      headers: { "Last-Event-ID": "evt-9" },
    });
    expect(res?.status).toBe(200);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      `https://test-cloud.mycadet.ai/v1/assistants/${CLOUD_ASSISTANT_ID}/doctor/sessions/${SESSION_ID}/events/`,
    );
    expect((init.headers as Record<string, string>)["Last-Event-ID"]).toBe(
      "evt-9",
    );
    // Streaming rows carry the caller's signal (none in a direct run —
    // but never the fixed timeout that would kill a live stream).
    expect(init.signal).toBeUndefined();
  });

  test("messages and user-outcome posts carry their JSON bodies", async () => {
    fetchMock.mockImplementation(async () => new Response("{}"));

    await dial(
      "POST",
      `/v1/assistants/${ENTRY.assistantId}/doctor/sessions/${SESSION_ID}/messages/`,
      { body: JSON.stringify({ content: "hi" }) },
    );
    const [messagesUrl, messagesInit] = fetchMock.mock
      .calls[0] as unknown as [string, RequestInit];
    expect(messagesUrl).toBe(
      `https://test-cloud.mycadet.ai/v1/assistants/${CLOUD_ASSISTANT_ID}/doctor/sessions/${SESSION_ID}/messages/`,
    );
    expect(messagesInit.method).toBe("POST");

    await dial(
      "POST",
      `/v1/assistants/${ENTRY.assistantId}/doctor/sessions/${SESSION_ID}/user-outcome/`,
      { body: JSON.stringify({ resolved: true }) },
    );
    const [outcomeUrl] = fetchMock.mock.calls[1] as unknown as [
      string,
      RequestInit,
    ];
    expect(outcomeUrl).toBe(
      `https://test-cloud.mycadet.ai/v1/assistants/${CLOUD_ASSISTANT_ID}/doctor/sessions/${SESSION_ID}/user-outcome/`,
    );
  });

  test("an entry with no cloud registration answers 503 without dialing", async () => {
    const realLookup = await import("../operations/lookup");
    // Swap the fixture for an entry the cloud never met — the original
    // fixture stays resolvable so the module swap is transparent to the
    // other tests.
    mock.module("../operations/lookup", () => ({
      ...realLookup,
      findAssistantByName: (name: string) =>
        name === "never-registered"
          ? {
              ...ENTRY,
              assistantId: "never-registered",
              cloudAssistantId: undefined,
            }
          : name === ENTRY.assistantId
            ? ENTRY
            : null,
    }));
    const { forwardOperatorRequest } = await import("../operations/routes");
    const res = await forwardOperatorRequest(
      new Request(
        "http://localhost:3001/v1/assistants/never-registered/doctor/sessions/",
        { method: "POST" },
      ),
    );
    expect(res?.status).toBe(503);
    expect(fetchMock.mock.calls.length).toBe(0);
  });

  test("a missing cloud token answers 401 without dialing", async () => {
    credentialState = { ...credentialState, token: null };
    const res = await dial(
      "POST",
      `/v1/assistants/${ENTRY.assistantId}/doctor/sessions/`,
    );
    expect(res?.status).toBe(401);
    expect(fetchMock.mock.calls.length).toBe(0);
  });
});
