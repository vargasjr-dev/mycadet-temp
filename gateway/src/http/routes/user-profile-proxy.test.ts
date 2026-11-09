import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

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

let credentialValues: Record<string, string | undefined> = {};

mock.module("../../credential-cache.js", () => ({
  getCredentials: () => ({
    get: async (key: string) => credentialValues[key],
  }),
}));

const {
  handleUserMeGet,
  handleUserMePatch,
  handleUsernameAvailableGet,
} = await import("./user-profile-proxy.js");

const PLATFORM_BASE_URL = "https://test-cloud.mycadet.ai";
const ASSISTANT_API_KEY = "assistant-api-key-123";

const USER_ME = {
  id: "u-1",
  username: "ada",
  email: "ada@example.com",
  first_name: "Ada",
  last_name: "Lovelace",
};

function registeredCredentials() {
  process.env.CADET_CLOUD_URL = PLATFORM_BASE_URL;
  credentialValues = {
    [credentialKey("cadet", "assistant_api_key")]: ASSISTANT_API_KEY,
  };
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

describe("platform user-profile proxy", () => {
  const savedCloudUrl = process.env.CADET_CLOUD_URL;

  beforeAll(() => {
    delete process.env.CADET_CLOUD_URL;
  });

  afterAll(() => {
    if (savedCloudUrl !== undefined) {
      process.env.CADET_CLOUD_URL = savedCloudUrl;
    } else {
      delete process.env.CADET_CLOUD_URL;
    }
  });

  afterEach(() => {
    fetchMock = mock(async () => new Response());
    credentialValues = {};
  });

  test("returns 503 and does not fetch when platform credentials are missing", async () => {
    const res = await handleUserMeGet(
      new Request("http://localhost:7830/v1/user/me/", { method: "GET" }),
    );

    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("PLATFORM_UNAVAILABLE");
    expect(body.error.message).toContain("not registered");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("forwards GET /v1/user/me to the platform with the assistant API key", async () => {
    fetchMock = mock(
      async () =>
        new Response(JSON.stringify(USER_ME), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    registeredCredentials();

    const res = await handleUserMeGet(
      new Request("http://localhost:7830/v1/user/me/", { method: "GET" }),
    );

    expect(res.status).toBe(200);
    const captured = capturedFetch();
    expect(captured.url).toBe(`${PLATFORM_BASE_URL}/v1/user/me/`);
    expect(captured.method).toBe("GET");
    expect(captured.headers.get("Authorization")).toBe(
      `Api-Key ${ASSISTANT_API_KEY}`,
    );
    expect(await res.json()).toEqual(USER_ME);
  });

  test("forwards the PATCH body verbatim and passes the upstream DRF error through", async () => {
    // The platform's 409 field-error body must survive untouched — the
    // web's parseDrfFieldError keys on this exact shape.
    const drf409 = { username: ["A user with that username already exists."] };
    fetchMock = mock(
      async () =>
        new Response(JSON.stringify(drf409), {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
    );
    registeredCredentials();

    const res = await handleUserMePatch(
      new Request("http://localhost:7830/v1/user/me/", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "grace" }),
      }),
    );

    expect(res.status).toBe(409);
    const captured = capturedFetch();
    expect(captured.url).toBe(`${PLATFORM_BASE_URL}/v1/user/me/`);
    expect(captured.method).toBe("PATCH");
    expect(JSON.parse(captured.body)).toEqual({ username: "grace" });
    expect(captured.headers.get("content-type")).toBe("application/json");
    expect((await res.json()) as unknown).toEqual(drf409);
  });

  test("forwards the username-available query string", async () => {
    fetchMock = mock(
      async () =>
        new Response(
          JSON.stringify({ available: false, code: "taken", message: null }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    registeredCredentials();

    const res = await handleUsernameAvailableGet(
      new Request(
        "http://localhost:7830/v1/user/username-available/?username=grace",
        { method: "GET" },
      ),
    );

    expect(res.status).toBe(200);
    const captured = capturedFetch();
    expect(captured.url).toBe(
      `${PLATFORM_BASE_URL}/v1/user/username-available/?username=grace`,
    );
    expect(await res.json()).toEqual({
      available: false,
      code: "taken",
      message: null,
    });
  });

  test("answers 502 when the platform is unreachable", async () => {
    fetchMock = mock(async () => {
      throw new Error("connection refused");
    });
    registeredCredentials();

    const res = await handleUserMeGet(
      new Request("http://localhost:7830/v1/user/me/", { method: "GET" }),
    );

    expect(res.status).toBe(502);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("PLATFORM_UNAVAILABLE");
    expect(body.error.message).toContain("Could not reach Cadet Cloud");
  });
});
