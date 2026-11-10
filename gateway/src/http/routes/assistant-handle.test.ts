import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import { credentialKey } from "../../credential-key.js";
import { ROUTES } from "./assistant-handle.js";

// The arms' handlers ignore the request path (the hop carries the bound
// platform id) — dispatch straight off the route table.
const handlerFor = (method: string, path: string) => {
  const route = ROUTES.find((r) => r.method === method && r.path === path)!;
  return route.handler as (req: Request) => Promise<Response>;
};

type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

let fetchMock: ReturnType<typeof mock<FetchFn>> = mock(
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
const { getCloudBaseUrl } = await import("../../cloud-url.js");

const PLATFORM_ASSISTANT_ID = "11111111-1111-4111-8111-111111111111";
const ASSISTANT_API_KEY = "assistant-api-key-123";

describe("the assistant's public-identity arms", () => {
  beforeEach(() => {
    applyCloudIdentityIds({
      assistantId: PLATFORM_ASSISTANT_ID,
      organizationId: "",
      userId: PLATFORM_ASSISTANT_ID,
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

  test("handle availability hops to the platform's assistant-scoped check", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ available: true, code: null, message: null }), {
          status: 200,
        }),
    );

    const handler = handlerFor("get", "/handle-available");
    const res = await handler(
      new Request(
        `http://localhost:7830/v1/assistants/self/handle-available/?handle=Ada`,
      ),
    );
    expect(res.status).toBe(200);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://test-cloud.mycadet.ai/v1/assistants/${PLATFORM_ASSISTANT_ID}/handle-available/?handle=Ada`,
    );
    expect((init.headers as Headers).get("Authorization")).toBe(
      `Api-Key ${ASSISTANT_API_KEY}`,
    );
  });

  test("the handle claim PATCHes the platform's assistant record", async () => {
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify({ handle: "ada" }), { status: 200 }),
    );

    const handler = handlerFor("patch", "/handle");
    const res = await handler(
      new Request("http://localhost:7830/v1/assistants/self/handle/", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle: "ada" }),
      }),
    );
    expect(res.status).toBe(200);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://test-cloud.mycadet.ai/v1/assistants/${PLATFORM_ASSISTANT_ID}/`,
    );
    expect((init as RequestInit).method).toBe("PATCH");
    // The hop forwards the body as an ArrayBuffer.
    const forwarded = Buffer.from(init.body as ArrayBuffer).toString();
    expect(JSON.parse(forwarded)).toEqual({ handle: "ada" });
  });

  test("the domains list hops to the platform's domains", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ results: [] }), { status: 200 }),
    );

    const handler = handlerFor("get", "/domains");
    const res = await handler(
      new Request("http://localhost:7830/v1/assistants/self/domains/"),
    );
    expect(res.status).toBe(200);

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://test-cloud.mycadet.ai/v1/assistants/${PLATFORM_ASSISTANT_ID}/domains/`,
    );
  });
});
