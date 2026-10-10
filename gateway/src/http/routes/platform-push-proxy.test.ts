import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import type { CredentialCache } from "../../credential-cache.js";
import { credentialKey } from "../../credential-key.js";

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

const { createPlatformPushProxyHandler } =
  await import("./platform-push-proxy.js");
const { applyCloudIdentityIds, _resetCloudIdentityForTests } =
  await import("../../cloud-identity.js");

const PLATFORM_ASSISTANT_ID = "11111111-1111-4111-8111-111111111111";
const PLATFORM_BASE_URL = "https://test-cloud.mycadet.ai";
const ASSISTANT_API_KEY = "assistant-api-key-123";

function makeKeyedCredentials(
  values: Record<string, string | undefined>,
): CredentialCache {
  return {
    get: mock(async (key: string) => values[key]),
  } as unknown as CredentialCache;
}

function registeredCredentials(): CredentialCache {
  applyCloudIdentityIds({
    assistantId: PLATFORM_ASSISTANT_ID,
    organizationId: "",
    userId: "",
  });
  process.env.CADET_PLATFORM_URL = PLATFORM_BASE_URL;
  return makeKeyedCredentials({
    [credentialKey("cadet", "assistant_api_key")]: ASSISTANT_API_KEY,
  });
}

function decodeBody(body: unknown): string {
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof ArrayBuffer) {
    return new TextDecoder().decode(body);
  }
  if (ArrayBuffer.isView(body)) {
    return new TextDecoder().decode(body);
  }
  return "";
}

function capturedFetch(): {
  url: string;
  method: string;
  headers: Headers;
  body: string;
} {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [input, init] = fetchMock.mock.calls[0]!;
  return {
    url: String(input),
    method: init?.method ?? "GET",
    headers: new Headers(init?.headers),
    body: decodeBody(init?.body),
  };
}

describe("platform push proxy", () => {
  const savedPlatformUrl = process.env.CADET_PLATFORM_URL;

  beforeAll(() => {
    delete process.env.CADET_PLATFORM_URL;
  });

  afterAll(() => {
    if (savedPlatformUrl !== undefined) {
      process.env.CADET_PLATFORM_URL = savedPlatformUrl;
    } else {
      delete process.env.CADET_PLATFORM_URL;
    }
  });

  afterEach(() => {
    fetchMock = mock(async () => new Response());
    _resetCloudIdentityForTests();
  });

  test("returns 503 and does not fetch when platform credentials are missing", async () => {
    const handler = createPlatformPushProxyHandler(makeKeyedCredentials({}));

    const res = await handler.handleUpsertPushToken(
      new Request("http://localhost:7830/v1/assistants/self/push-tokens/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "device-token", platform: "ios" }),
      }),
    );

    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("PLATFORM_UNAVAILABLE");
    expect(body.error.message).toContain("not registered");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("forwards a push-token upsert to Django with the stored UUID and API key", async () => {
    fetchMock = mock(
      async () =>
        new Response(JSON.stringify({ token: "device-token" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const handler = createPlatformPushProxyHandler(registeredCredentials());
    const payload = {
      token: "device-token",
      platform: "ios",
      bundle_id: "ai.mycadet.android",
    };

    const res = await handler.handleUpsertPushToken(
      new Request("http://localhost:7830/v1/assistants/self/push-tokens/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: "Bearer actor-token",
        },
        body: JSON.stringify(payload),
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ token: "device-token" });

    const upstream = capturedFetch();
    expect(upstream.url).toBe(
      `${PLATFORM_BASE_URL}/v1/assistants/${PLATFORM_ASSISTANT_ID}/push-tokens/`,
    );
    expect(upstream.method).toBe("POST");
    expect(upstream.headers.get("Authorization")).toBe(
      `Api-Key ${ASSISTANT_API_KEY}`,
    );
    expect(upstream.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(upstream.body)).toEqual(payload);
  });

  test("preserves bundle_id on push-token delete and ignores the URL assistant id", async () => {
    fetchMock = mock(async () => new Response(null, { status: 204 }));
    const handler = createPlatformPushProxyHandler(registeredCredentials());

    const res = await handler.handleDeletePushToken(
      new Request(
        "http://localhost:7830/v1/assistants/self/push-tokens/device-token/?bundle_id=ai.mycadet.android",
        { method: "DELETE" },
      ),
      "device-token",
    );

    expect(res.status).toBe(204);
    const upstream = capturedFetch();
    expect(upstream.url).toBe(
      `${PLATFORM_BASE_URL}/v1/assistants/${PLATFORM_ASSISTANT_ID}/push-tokens/device-token/?bundle_id=ai.mycadet.android`,
    );
    expect(upstream.method).toBe("DELETE");
    expect(upstream.headers.get("Authorization")).toBe(
      `Api-Key ${ASSISTANT_API_KEY}`,
    );
  });

  test("forwards a Live Activity token upsert to Django", async () => {
    fetchMock = mock(
      async () =>
        new Response(JSON.stringify({ token: "activity-token" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const handler = createPlatformPushProxyHandler(registeredCredentials());

    const res = await handler.handleUpsertLiveActivityToken(
      new Request(
        "http://localhost:7830/v1/assistants/self/live-activity/tokens/",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: "activity-token" }),
        },
      ),
    );

    expect(res.status).toBe(200);
    const upstream = capturedFetch();
    expect(upstream.url).toBe(
      `${PLATFORM_BASE_URL}/v1/assistants/${PLATFORM_ASSISTANT_ID}/live-activity/tokens/`,
    );
  });

  test("forwards a Live Activity token delete to Django", async () => {
    fetchMock = mock(async () => new Response(null, { status: 204 }));
    const handler = createPlatformPushProxyHandler(registeredCredentials());

    const res = await handler.handleDeleteLiveActivityToken(
      new Request(
        "http://localhost:7830/v1/assistants/self/live-activity/tokens/activity-token/",
        { method: "DELETE" },
      ),
      "activity-token",
    );

    expect(res.status).toBe(204);
    const upstream = capturedFetch();
    expect(upstream.url).toBe(
      `${PLATFORM_BASE_URL}/v1/assistants/${PLATFORM_ASSISTANT_ID}/live-activity/tokens/activity-token/`,
    );
  });

  test("passes through a Django 400", async () => {
    fetchMock = mock(
      async () =>
        new Response(JSON.stringify({ detail: "bundle_id is required." }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    );
    const handler = createPlatformPushProxyHandler(registeredCredentials());

    const res = await handler.handleDeletePushToken(
      new Request(
        "http://localhost:7830/v1/assistants/self/push-tokens/device-token/",
        { method: "DELETE" },
      ),
      "device-token",
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ detail: "bundle_id is required." });
  });

  test("returns 502 when the platform request fails", async () => {
    fetchMock = mock(async () => {
      throw new Error("network down");
    });
    const handler = createPlatformPushProxyHandler(registeredCredentials());

    const res = await handler.handleUpsertPushToken(
      new Request("http://localhost:7830/v1/assistants/self/push-tokens/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: "device-token", platform: "ios" }),
      }),
    );

    expect(res.status).toBe(502);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("PLATFORM_UNAVAILABLE");
  });
});
