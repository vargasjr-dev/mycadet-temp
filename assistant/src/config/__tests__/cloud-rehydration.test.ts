import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { credentialKey } from "../../security/credential-key.js";

let mockSecureKeys: Record<string, string> = {};
let throwForKey: string | undefined;

mock.module("../../security/secure-keys.js", () => ({
  getSecureKeyAsync: async (key: string) => {
    if (throwForKey && key === throwForKey) {
      throw new Error("credential store unreachable");
    }
    return mockSecureKeys[key] ?? undefined;
  },
  // Peer tests in a combined run import this name from the same module; stub
  // it so their ESM named-import validation is satisfied when this mock wins.
  deleteSecureKeyAsync: async () => ({ deleted: false }),
}));

const {
  getCloudAssistantId,
  getCloudOrganizationId,
  getCloudUserId,
  setCloudAssistantId,
  setCloudOrganizationId,
  setCloudUserId,
} = await import("../env.js");
const { _resetPlatformIdentityEnsureForTests } =
  await import("../cloud-identity.js");
const { rehydrateCloudCredentials } = await import("../cloud-rehydration.js");

const PROD_URL = "https://cloud.mycadet.ai";
const ASSISTANT_ID = "11111111-2222-4333-8444-555555555555";
const ORG_ID = "22222222-3333-4444-8555-666666666666";
const USER_ID = "33333333-4444-4555-8666-777777777777";

describe("rehydrateCloudCredentials", () => {
  const originalPlatformUrlEnv = process.env.CADET_PLATFORM_URL;
  const originalOrgEnv = process.env.CLOUD_ORGANIZATION_ID;
  const originalUserEnv = process.env.CLOUD_USER_ID;
  const originalAssistantApiKeyEnv = process.env.ASSISTANT_API_KEY;
  const originalFetch = globalThis.fetch;
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  let fetchImpl: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response> = async () =>
    new Response("not found", { status: 404 });

  beforeEach(() => {
    mockSecureKeys = {};
    throwForKey = undefined;
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
    // Env vars take precedence over the rehydrated overrides for some fields;
    // clear them so the credential-store values are what we observe.
    delete process.env.CADET_PLATFORM_URL;
    delete process.env.CLOUD_ORGANIZATION_ID;
    delete process.env.CLOUD_USER_ID;
    delete process.env.ASSISTANT_API_KEY;
    // Reset in-memory overrides between tests.
    setCloudAssistantId(undefined);
    setCloudOrganizationId(undefined);
    setCloudUserId(undefined);
    _resetPlatformIdentityEnsureForTests();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalPlatformUrlEnv === undefined) {
      delete process.env.CADET_PLATFORM_URL;
    } else {
      process.env.CADET_PLATFORM_URL = originalPlatformUrlEnv;
    }
    if (originalOrgEnv === undefined) {
      delete process.env.PLATFORM_ORGANIZATION_ID;
    } else {
      process.env.CLOUD_ORGANIZATION_ID = originalOrgEnv;
    }
    if (originalUserEnv === undefined) {
      delete process.env.PLATFORM_USER_ID;
    } else {
      process.env.CLOUD_USER_ID = originalUserEnv;
    }
    if (originalAssistantApiKeyEnv === undefined) {
      delete process.env.ASSISTANT_API_KEY;
    } else {
      process.env.ASSISTANT_API_KEY = originalAssistantApiKeyEnv;
    }
    setCloudAssistantId(undefined);
    setCloudOrganizationId(undefined);
    setCloudUserId(undefined);
  });

  test("leaves overrides untouched when nothing is stored", async () => {
    await rehydrateCloudCredentials();

    expect(getCloudAssistantId()).toBe("");
    expect(getCloudOrganizationId()).toBe("");
    expect(getCloudUserId()).toBe("");
  });

  test("a credential-store read failure does not throw", async () => {
    throwForKey = credentialKey("cadet", "assistant_api_key");

    await expect(rehydrateCloudCredentials()).resolves.toBeUndefined();
    expect(getCloudAssistantId()).toBe("");
  });

  test("trades the assistant API key for ids via platform validate", async () => {
    process.env.CADET_PLATFORM_URL = PROD_URL;
    mockSecureKeys[credentialKey("cadet", "assistant_api_key")] =
      "assistant-key";
    fetchImpl = async () =>
      new Response(
        JSON.stringify({
          assistant_id: ASSISTANT_ID,
          organization_id: ORG_ID,
          user_id: USER_ID,
        }),
        { status: 200 },
      );

    await rehydrateCloudCredentials();

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe(
      `${PROD_URL}/v1/internal/assistants/validate/`,
    );
    const headers = new Headers(fetchCalls[0]?.init?.headers);
    expect(headers.get("Authorization")).toBe("Api-Key assistant-key");
    expect(getCloudAssistantId()).toBe(ASSISTANT_ID);
    expect(getCloudOrganizationId()).toBe(ORG_ID);
    expect(getCloudUserId()).toBe(USER_ID);
  });

  test("validate ids are used when the vault also has a copy", async () => {
    mockSecureKeys[credentialKey("cadet", "assistant_api_key")] =
      "assistant-key";
    mockSecureKeys[credentialKey("cadet", "platform_assistant_id")] =
      "asst-from-vault";
    fetchImpl = async () =>
      new Response(
        JSON.stringify({
          assistant_id: ASSISTANT_ID,
          organization_id: ORG_ID,
          user_id: USER_ID,
        }),
        { status: 200 },
      );

    await rehydrateCloudCredentials();

    expect(getCloudAssistantId()).toBe(ASSISTANT_ID);
  });

  test("does not populate ids from the vault when validate is unreachable", async () => {
    mockSecureKeys[credentialKey("cadet", "assistant_api_key")] =
      "assistant-key";
    mockSecureKeys[credentialKey("cadet", "platform_assistant_id")] =
      ASSISTANT_ID;
    fetchImpl = async () => {
      throw new Error("network down");
    };

    await rehydrateCloudCredentials();

    expect(getCloudAssistantId()).toBe("");
    expect(getCloudOrganizationId()).toBe("");
    expect(getCloudUserId()).toBe("");
  });
});
