import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import { credentialKey } from "../../credential-key.js";
import { ROUTES } from "./assistant-doctor.js";

// The arms' handlers ignore the request path (the hop carries the bound
// cloud id) — dispatch straight off the route table.
const handlerFor = (method: string, path: string) => {
  const route = ROUTES.find((r) => r.method === method && r.path === path)!;
  return route.handler as (
    req: Request,
    params: string[],
  ) => Promise<Response>;
};

type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const fetchMock: ReturnType<typeof mock<FetchFn>> = mock(
  async () => new Response(),
);

mock.module("../../fetch.js", () => ({
  fetchImpl: (...args: Parameters<FetchFn>) => fetchMock(...args),
}));

let credentialValues: Record<string, string | undefined> = {};

mock.module("../../credential-cache.js", () => ({
  getCredentials: () => ({
    get: async (key: string) => credentialValues[key],
  }),
}));

const { applyCloudIdentityIds, _resetCloudIdentityForTests } = await import(
  "../../cloud-identity.js"
);

const CLOUD_ASSISTANT_ID = "22222222-2222-4222-8222-222222222222";
const ASSISTANT_API_KEY = "assistant-api-key-456";
const SESSION_ID = "doctor-sess-1";

describe("the doctor-session arms", () => {
  beforeEach(() => {
    applyCloudIdentityIds({
      assistantId: CLOUD_ASSISTANT_ID,
      organizationId: "",
      userId: CLOUD_ASSISTANT_ID,
    });
    credentialValues = {
      [credentialKey("cadet", "assistant_api_key")]: ASSISTANT_API_KEY,
    };
    process.env.CADET_CLOUD_URL = "https://test-cloud.mycadet.ai";
  });

  afterEach(() => {
    fetchMock.mockReset();
    _resetCloudIdentityForTests();
  });

  test("history list forwards the query string and the api key", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ results: [] }), { status: 200 }),
    );

    const handler = handlerFor("get", "/doctor/history");
    const res = await handler(
      new Request("http://localhost:7830/v1/doctor/history/?limit=1"),
      [],
    );
    expect(res.status).toBe(200);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://test-cloud.mycadet.ai/v1/assistants/${CLOUD_ASSISTANT_ID}/doctor/history/?limit=1`,
    );
    expect((init.headers as Headers).get("Authorization")).toBe(
      `Api-Key ${ASSISTANT_API_KEY}`,
    );
  });

  test("history retrieve carries the doctor session id on the upstream path", async () => {
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify({ id: SESSION_ID }), { status: 200 }),
    );

    const handler = handlerFor("get", "/doctor/history/{doctor_session_id}");
    await handler(
      new Request(
        `http://localhost:7830/v1/doctor/history/${SESSION_ID}/`,
      ),
      [SESSION_ID],
    );

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://test-cloud.mycadet.ai/v1/assistants/${CLOUD_ASSISTANT_ID}/doctor/history/${SESSION_ID}/`,
    );
  });

  test("the event stream forwards Last-Event-ID and binds to the caller's signal", async () => {
    fetchMock.mockImplementation(
      async () => new Response("event: message\ndata: {}\n\n", { status: 200 }),
    );

    const handler = handlerFor("get", "/doctor/sessions/{session_id}/events");
    const req = new Request(
      `http://localhost:7830/v1/assistants/self/doctor/sessions/${SESSION_ID}/events/`,
      { headers: { "Last-Event-ID": "evt-42" } },
    );
    await handler(req, [SESSION_ID]);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://test-cloud.mycadet.ai/v1/assistants/${CLOUD_ASSISTANT_ID}/doctor/sessions/${SESSION_ID}/events/`,
    );
    expect((init.headers as Headers).get("Last-Event-ID")).toBe("evt-42");
    // Streaming dials bind to the caller's own disconnect signal — the
    // fixed 10s hop timeout would kill a live session stream.
    expect(init.signal).toBe(req.signal);
  });

  test("message posts and outcome writes hop session-scoped paths", async () => {
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify({}), { status: 200 }),
    );

    const messages = handlerFor("post", "/doctor/sessions/{session_id}/messages");
    await messages(
      new Request(
        `http://localhost:7830/v1/doctor/sessions/${SESSION_ID}/messages/`,
        { method: "POST", body: JSON.stringify({ text: "hi" }) },
      ),
      [SESSION_ID],
    );
    const [messagesUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(messagesUrl).toBe(
      `https://test-cloud.mycadet.ai/v1/assistants/${CLOUD_ASSISTANT_ID}/doctor/sessions/${SESSION_ID}/messages/`,
    );

    const outcome = handlerFor(
      "post",
      "/doctor/sessions/{session_id}/user-outcome",
    );
    await outcome(
      new Request(
        `http://localhost:7830/v1/doctor/sessions/${SESSION_ID}/user-outcome/`,
        { method: "POST", body: JSON.stringify({ outcome: "approve" }) },
      ),
      [SESSION_ID],
    );
    const [outcomeUrl] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(outcomeUrl).toBe(
      `https://test-cloud.mycadet.ai/v1/assistants/${CLOUD_ASSISTANT_ID}/doctor/sessions/${SESSION_ID}/user-outcome/`,
    );
  });
});
