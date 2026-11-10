import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import { credentialKey } from "../../credential-key.js";
import { ROUTES } from "./assistant-terminal.js";

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

const CLOUD_ASSISTANT_ID = "11111111-1111-4111-8111-111111111111";
const ASSISTANT_API_KEY = "assistant-api-key-123";
const SESSION_ID = "sess-abc-123";

describe("the terminal-session arms", () => {
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

  test("session create hops to the cloud's terminal session collection", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ session_id: SESSION_ID }), {
          status: 200,
        }),
    );

    const handler = handlerFor("post", "/terminal/sessions");
    const res = await handler(
      new Request("http://localhost:7830/v1/terminal/sessions/", {
        method: "POST",
        body: JSON.stringify({ service: "shell" }),
        headers: { "Content-Type": "application/json" },
      }),
      [],
    );
    expect(res.status).toBe(200);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://test-cloud.mycadet.ai/v1/assistants/${CLOUD_ASSISTANT_ID}/terminal/sessions/`,
    );
    expect(init.method).toBe("POST");
    expect((init.headers as Headers).get("Authorization")).toBe(
      `Api-Key ${ASSISTANT_API_KEY}`,
    );
  });

  test("input and destroy carry the session id on the upstream path", async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 204 }));

    const input = handlerFor("post", "/terminal/sessions/{session_id}/input");
    await input(
      new Request(`http://localhost:7830/v1/terminal/sessions/${SESSION_ID}/input/`, {
        method: "POST",
        body: JSON.stringify({ data: "ls\n" }),
        headers: { "Content-Type": "application/json" },
      }),
      [SESSION_ID],
    );

    const [inputUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(inputUrl).toBe(
      `https://test-cloud.mycadet.ai/v1/assistants/${CLOUD_ASSISTANT_ID}/terminal/sessions/${SESSION_ID}/input/`,
    );

    const destroy = handlerFor("delete", "/terminal/sessions/{session_id}");
    await destroy(
      new Request(`http://localhost:7830/v1/terminal/sessions/${SESSION_ID}`, {
        method: "DELETE",
      }),
      [SESSION_ID],
    );

    const [destroyUrl, destroyInit] = fetchMock.mock
      .calls[1] as [string, RequestInit];
    expect(destroyUrl).toBe(
      `https://test-cloud.mycadet.ai/v1/assistants/${CLOUD_ASSISTANT_ID}/terminal/sessions/${SESSION_ID}/`,
    );
    expect(destroyInit.method).toBe("DELETE");
  });

  test("the event stream is bound to the caller's signal, not the fixed timeout", async () => {
    fetchMock.mockImplementation(
      async () => new Response("event: output\ndata: {}\n\n", { status: 200 }),
    );

    const handler = handlerFor("get", "/terminal/sessions/{session_id}/events");
    const req = new Request(
      `http://localhost:7830/v1/assistants/self/terminal/sessions/${SESSION_ID}/events/`,
    );
    await handler(req, [SESSION_ID]);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://test-cloud.mycadet.ai/v1/assistants/${CLOUD_ASSISTANT_ID}/terminal/sessions/${SESSION_ID}/events/`,
    );
    // Streaming dials bind to the caller's own disconnect signal — the
    // fixed 10s hop timeout would kill a live PTY stream.
    expect(init.signal).toBe(req.signal);
  });

  test("unconfigured assistants short-circuit before any upstream dial", async () => {
    credentialValues = {};
    const handler = handlerFor("post", "/terminal/sessions");
    const res = await handler(
      new Request("http://localhost:7830/v1/terminal/sessions/", {
        method: "POST",
      }),
      [],
    );
    expect(res.status).toBe(503);
    expect(fetchMock.mock.calls.length).toBe(0);
  });
});
