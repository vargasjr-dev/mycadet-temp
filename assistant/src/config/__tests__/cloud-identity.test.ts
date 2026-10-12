import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { useFaultableSecureKeyMap } from "../../__tests__/helpers/secure-keys.js";
import { credentialKey } from "../../security/credential-key.js";
import {
  getCloudAssistantId,
  getCloudBaseUrl,
  setCloudAssistantId,
  setCloudOrganizationId,
  setCloudUserId,
} from "../env.js";

const { setUnreachableKey } = useFaultableSecureKeyMap();
const {
  _resetCloudIdentityEnsureForTests,
  ensureCloudIdentityIds,
  fetchCloudIdentityIds,
  CLOUD_IDENTITY_VALIDATE_PATH,
  resolveCloudAssistantId,
} = await import("../cloud-identity.js");

const BASE_URL = "https://cloud.mycadet.ai";
const ASSISTANT_ID = "11111111-2222-4333-8444-555555555555";
const ORG_ID = "22222222-3333-4444-8555-666666666666";
const USER_ID = "33333333-4444-4555-8666-777777777777";

describe("fetchCloudIdentityIds", () => {
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  let fetchImpl: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response> = async () =>
    new Response("not found", { status: 404 });

  beforeEach(() => {
    fetchCalls.length = 0;
    fetchImpl = async () => new Response("not found", { status: 404 });
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string" ? input : input.toString();
      fetchCalls.push({ url, init });
      return fetchImpl(input, init);
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns the three ids from a successful validate response", async () => {
    fetchImpl = async () =>
      new Response(
        JSON.stringify({
          assistant_id: ASSISTANT_ID,
          organization_id: ORG_ID,
          user_id: USER_ID,
          name: "Example Assistant",
        }),
        { status: 200 },
      );

    await expect(
      fetchCloudIdentityIds(BASE_URL, "assistant-key"),
    ).resolves.toEqual({
      assistantId: ASSISTANT_ID,
      organizationId: ORG_ID,
      userId: USER_ID,
    });
    expect(fetchCalls[0]?.url).toBe(
      `${BASE_URL}${CLOUD_IDENTITY_VALIDATE_PATH}`,
    );
    expect(fetchCalls[0]?.init?.method).toBe("POST");
    const headers = new Headers(fetchCalls[0]?.init?.headers);
    expect(headers.get("Authorization")).toBe("Api-Key assistant-key");
  });

  test("strips a trailing slash from the base URL", async () => {
    fetchImpl = async () =>
      new Response(
        JSON.stringify({
          assistant_id: ASSISTANT_ID,
          organization_id: ORG_ID,
          user_id: USER_ID,
        }),
        { status: 200 },
      );

    await fetchCloudIdentityIds(`${BASE_URL}/`, "assistant-key");
    expect(fetchCalls[0]?.url).toBe(
      `${BASE_URL}${CLOUD_IDENTITY_VALIDATE_PATH}`,
    );
  });

  test("returns null on 401 without throwing", async () => {
    fetchImpl = async () => new Response("no", { status: 401 });
    await expect(
      fetchCloudIdentityIds(BASE_URL, "assistant-key"),
    ).resolves.toBeNull();
  });

  test("returns null on a network error without throwing", async () => {
    fetchImpl = async () => {
      throw new Error("network down");
    };
    await expect(
      fetchCloudIdentityIds(BASE_URL, "assistant-key"),
    ).resolves.toBeNull();
  });
});

describe("resolveCloudAssistantId", () => {
  const originalFetch = globalThis.fetch;
  const originalAssistantApiKeyEnv = process.env.ASSISTANT_API_KEY;
  const originalCloudUrlEnv = process.env.CADET_CLOUD_URL;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  let fetchImpl: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response> = async () =>
    new Response("not found", { status: 404 });

  beforeEach(() => {
    fetchCalls.length = 0;
    fetchImpl = async () => new Response("not found", { status: 404 });
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string" ? input : input.toString();
      fetchCalls.push({ url, init });
      return fetchImpl(input, init);
    }) as unknown as typeof fetch;
    delete process.env.ASSISTANT_API_KEY;
    delete process.env.CADET_CLOUD_URL;
    setCloudAssistantId(undefined);
    setCloudOrganizationId(undefined);
    setCloudUserId(undefined);
    _resetCloudIdentityEnsureForTests();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalAssistantApiKeyEnv === undefined) {
      delete process.env.ASSISTANT_API_KEY;
    } else {
      process.env.ASSISTANT_API_KEY = originalAssistantApiKeyEnv;
    }
    if (originalCloudUrlEnv === undefined) {
      delete process.env.CADET_CLOUD_URL;
    } else {
      process.env.CADET_CLOUD_URL = originalCloudUrlEnv;
    }
    setCloudAssistantId(undefined);
    setCloudOrganizationId(undefined);
    setCloudUserId(undefined);
    _resetCloudIdentityEnsureForTests();
  });

  test("returns the in-memory override without calling validate", async () => {
    setCloudAssistantId(ASSISTANT_ID);
    process.env.ASSISTANT_API_KEY = "assistant-key";
    await expect(resolveCloudAssistantId()).resolves.toBe(ASSISTANT_ID);
    expect(fetchCalls).toHaveLength(0);
  });

  test("returns empty when the in-memory override is unset and there is no API key", async () => {
    await expect(resolveCloudAssistantId()).resolves.toBe("");
    expect(fetchCalls).toHaveLength(0);
  });

  test("loads ids from validate when the in-memory override is empty", async () => {
    process.env.ASSISTANT_API_KEY = "assistant-key";
    process.env.CADET_CLOUD_URL = BASE_URL;
    fetchImpl = async () =>
      new Response(
        JSON.stringify({
          assistant_id: ASSISTANT_ID,
          organization_id: ORG_ID,
          user_id: USER_ID,
        }),
        { status: 200 },
      );

    await expect(resolveCloudAssistantId()).resolves.toBe(ASSISTANT_ID);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe(
      `${getCloudBaseUrl().replace(/\/+$/, "")}${CLOUD_IDENTITY_VALIDATE_PATH}`,
    );
  });

  test("does not retry validate during the cooldown after a failure", async () => {
    process.env.ASSISTANT_API_KEY = "assistant-key";
    process.env.CADET_CLOUD_URL = BASE_URL;
    fetchImpl = async () => new Response("down", { status: 503 });

    await expect(resolveCloudAssistantId()).resolves.toBe("");
    await expect(resolveCloudAssistantId()).resolves.toBe("");
    expect(fetchCalls).toHaveLength(1);
  });

  test("retries validate inside the cooldown once a different API key is stored", async () => {
    process.env.ASSISTANT_API_KEY = "rejected-key";
    process.env.CADET_CLOUD_URL = BASE_URL;
    fetchImpl = async () => new Response("no", { status: 401 });

    await expect(resolveCloudAssistantId()).resolves.toBe("");
    expect(fetchCalls).toHaveLength(1);

    process.env.ASSISTANT_API_KEY = "replacement-key";
    fetchImpl = async () =>
      new Response(
        JSON.stringify({
          assistant_id: ASSISTANT_ID,
          organization_id: ORG_ID,
          user_id: USER_ID,
        }),
        { status: 200 },
      );

    await expect(resolveCloudAssistantId()).resolves.toBe(ASSISTANT_ID);
    expect(fetchCalls).toHaveLength(2);
    const headers = new Headers(fetchCalls[1]?.init?.headers);
    expect(headers.get("Authorization")).toBe("Api-Key replacement-key");
  });

  test("retries validate inside the cooldown once a different base URL is stored", async () => {
    process.env.ASSISTANT_API_KEY = "assistant-key";
    // The environment URL outranks the in-memory override (and the test
    // preload sets one), so the base URL is changed through the environment.
    process.env.CADET_CLOUD_URL = "https://old.example.com";
    fetchImpl = async () => new Response("no", { status: 401 });

    await expect(resolveCloudAssistantId()).resolves.toBe("");
    expect(fetchCalls).toHaveLength(1);

    process.env.CADET_CLOUD_URL = BASE_URL;
    fetchImpl = async () =>
      new Response(
        JSON.stringify({
          assistant_id: ASSISTANT_ID,
          organization_id: ORG_ID,
          user_id: USER_ID,
        }),
        { status: 200 },
      );

    await expect(resolveCloudAssistantId()).resolves.toBe(ASSISTANT_ID);
    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[1]?.url).toBe(
      `${BASE_URL}${CLOUD_IDENTITY_VALIDATE_PATH}`,
    );
  });

  test("retries validate after a failed attempt once the cooldown is cleared", async () => {
    process.env.ASSISTANT_API_KEY = "assistant-key";
    process.env.CADET_CLOUD_URL = BASE_URL;
    fetchImpl = async () => new Response("down", { status: 503 });

    await expect(resolveCloudAssistantId()).resolves.toBe("");
    _resetCloudIdentityEnsureForTests();
    fetchImpl = async () =>
      new Response(
        JSON.stringify({
          assistant_id: ASSISTANT_ID,
          organization_id: ORG_ID,
          user_id: USER_ID,
        }),
        { status: 200 },
      );

    await expect(resolveCloudAssistantId()).resolves.toBe(ASSISTANT_ID);
    expect(fetchCalls).toHaveLength(2);
  });

  test("concurrent resolves share one in-flight validate", async () => {
    process.env.ASSISTANT_API_KEY = "assistant-key";
    process.env.CADET_CLOUD_URL = BASE_URL;
    let release!: (value: Response) => void;
    let notifyFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      notifyFetchStarted = resolve;
    });
    fetchImpl = () => {
      notifyFetchStarted();
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    };

    const first = resolveCloudAssistantId();
    const second = resolveCloudAssistantId();
    await fetchStarted;
    expect(fetchCalls).toHaveLength(1);
    release(
      new Response(
        JSON.stringify({
          assistant_id: ASSISTANT_ID,
          organization_id: ORG_ID,
          user_id: USER_ID,
        }),
        { status: 200 },
      ),
    );
    await expect(first).resolves.toBe(ASSISTANT_ID);
    await expect(second).resolves.toBe(ASSISTANT_ID);
    expect(fetchCalls).toHaveLength(1);
  });
});

describe("ensureCloudIdentityIds", () => {
  test("an unreachable credential store is non-fatal — identity stays unbound", async () => {
    process.env.CADET_PLATFORM_URL = BASE_URL;
    setUnreachableKey(credentialKey("cadet", "assistant_api_key"));

    await expect(ensureCloudIdentityIds()).resolves.toBeUndefined();
    expect(getCloudAssistantId()).toBe("");
  });
});
