/**
 * Tests for AssistantClient's cloud-managed (`cloud: "cloud"`) auth path.
 * These entries have no guardian token on disk, so the client must authenticate
 * with the stored platform credential instead of sending an anonymous request
 * (which the cloud answers with a bare 403).
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testDir = mkdtempSync(join(tmpdir(), "client-cloud-auth-test-"));
const ORIGINAL_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
const ORIGINAL_FETCH = globalThis.fetch;

import { AssistantClient } from "../lib/assistant-client.js";
import { saveLockfileAssistant } from "@mycadet/local-mode";
import { clearCloudToken, saveCloudToken } from "../lib/cloud-client.js";

const PLATFORM_URL = "https://platform.example.com";
const ASSISTANT_ID = "019d1e04-cb20-719a-b04b-310072904444";
const ORG_ID = "org-abc";

/** Seed a cloud-managed lockfile entry, optionally with a stored token. */
function seedCloud(token?: string): void {
  saveLockfileAssistant({
    assistantId: ASSISTANT_ID,
    name: "Credence",
    cloud: "cloud",
  });
  if (token) {
    saveCloudToken(token);
  }
}

interface Call {
  url: string;
  headers: Record<string, string>;
}

/** Replace global fetch with a URL-routed stub; returns the call log. */
function stubFetch(handler: (url: string, calls: Call[]) => Response): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    calls.push({
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return handler(url, calls);
  }) as typeof fetch;
  return calls;
}

const isOrgFetch = (url: string) => url.includes("/v1/organizations/");
const isRefresh = (url: string) => url.includes("/v1/guardian/refresh");

function orgResponse(): Response {
  return new Response(
    JSON.stringify({ results: [{ id: ORG_ID, name: "My Cadet" }] }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}

describe("AssistantClient cloud-managed auth", () => {
  beforeEach(() => {
    process.env.XDG_CONFIG_HOME = testDir;
    // Tests share testDir, so a token saved by an earlier one must not leak.
    clearCloudToken();
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    if (ORIGINAL_CONFIG_HOME === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = ORIGINAL_CONFIG_HOME;
    }
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test("sends X-Session-Token + Cadet-Organization-Id for a session token", async () => {
    seedCloud("sess-tok-1");
    const calls = stubFetch((url) =>
      isOrgFetch(url) ? orgResponse() : new Response("", { status: 200 }),
    );

    const client = new AssistantClient({ assistantId: ASSISTANT_ID });
    const res = await client.post("/messages/", { content: "hi" });

    expect(res.status).toBe(200);
    const assistantCall = calls.find((c) => !isOrgFetch(c.url))!;
    expect(assistantCall.url).toBe(
      `${PLATFORM_URL}/v1/assistants/${ASSISTANT_ID}/messages/`,
    );
    expect(assistantCall.headers["X-Session-Token"]).toBe("sess-tok-1");
    expect(assistantCall.headers["Cadet-Organization-Id"]).toBe(ORG_ID);
    expect(assistantCall.headers["Authorization"]).toBeUndefined();
    expect(assistantCall.headers["Content-Type"]).toBe("application/json");
  });

  test("resolves the auth headers once across multiple requests", async () => {
    seedCloud("sess-tok-2");
    const calls = stubFetch((url) =>
      isOrgFetch(url) ? orgResponse() : new Response("", { status: 200 }),
    );

    const client = new AssistantClient({ assistantId: ASSISTANT_ID });
    await client.get("/healthz/");
    await client.get("/healthz/");

    expect(calls.filter((c) => isOrgFetch(c.url))).toHaveLength(1);
    // A bodyless request must not claim a JSON body.
    const assistantCalls = calls.filter((c) => !isOrgFetch(c.url));
    expect(assistantCalls).toHaveLength(2);
    expect(assistantCalls[0].headers["Content-Type"]).toBeUndefined();
  });

  test("sends a bearer Authorization and no org header for a vak_ API key", async () => {
    seedCloud("vak_test_key");
    const calls = stubFetch((url) =>
      isOrgFetch(url) ? orgResponse() : new Response("", { status: 200 }),
    );

    const client = new AssistantClient({ assistantId: ASSISTANT_ID });
    await client.get("/healthz/");

    // API keys are already org-scoped, so no org lookup happens.
    expect(calls.filter((c) => isOrgFetch(c.url))).toHaveLength(0);
    const assistantCall = calls[0];
    expect(assistantCall.headers["Authorization"]).toBe("Bearer vak_test_key");
    expect(assistantCall.headers["Cadet-Organization-Id"]).toBeUndefined();
    expect(assistantCall.headers["X-Session-Token"]).toBeUndefined();
  });

  test("throws the login hint instead of sending an anonymous request", async () => {
    seedCloud(); // no platform token stored
    const calls = stubFetch(() => new Response("", { status: 200 }));

    const client = new AssistantClient({ assistantId: ASSISTANT_ID });

    await expect(client.post("/messages/", { content: "hi" })).rejects.toThrow(
      "Not logged in. Run `cadet login` first to authenticate with Cadet Cloud.",
    );
    expect(calls).toHaveLength(0);
  });

  test("dials the entry's recorded cloud host", async () => {
    seedCloud("sess-tok-5");
    stubFetch((url) =>
      isOrgFetch(url) ? orgResponse() : new Response("", { status: 200 }),
    );

    const client = new AssistantClient({ assistantId: ASSISTANT_ID });

    expect(client.runtimeUrl).toBe(PLATFORM_URL);
    expect((await client.get("/healthz/")).status).toBe(200);
  });

  test("re-resolves the org id once on a 401 and never refreshes a guardian token", async () => {
    seedCloud("sess-tok-3");
    let assistantAttempts = 0;
    const calls = stubFetch((url) => {
      if (isOrgFetch(url)) {
        return orgResponse();
      }
      assistantAttempts++;
      return new Response("", { status: 401 }); // always 401
    });

    const client = new AssistantClient({ assistantId: ASSISTANT_ID });
    const res = await client.get("/messages/");

    expect(res.status).toBe(401);
    expect(assistantAttempts).toBe(2); // original + one retry, no more
    // The cached org id was invalidated, so the retry refetched it.
    expect(calls.filter((c) => isOrgFetch(c.url))).toHaveLength(2);
    expect(calls.filter((c) => isRefresh(c.url))).toHaveLength(0);
  });
});
