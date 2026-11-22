import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import type { CredentialCache } from "../credential-cache.js";
import { credentialKey } from "../credential-key.js";

/**
 * fetchImpl exists as a module boundary precisely so tests can intercept
 * with mock.module — globalThis.fetch swapping is unreliable on some Bun
 * runtimes. Stubs the boundary before the recorder module loads.
 */
const fetchCalls: { url: string; init: RequestInit }[] = [];
let fetchResponse: () => Response = () => new Response("{}", { status: 200 });
let fetchThrows: Error | undefined;

mock.module("../fetch.js", () => ({
  fetchImpl: async (url: string | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init: (init ?? {}) as RequestInit });
    if (fetchThrows) throw fetchThrows;
    return fetchResponse();
  },
}));

const { buildEmailReceivedRecorder } = await import("./record-received.js");

function makeCaches(key?: string): { credentials: CredentialCache } {
  const store = new Map<string, string>();
  if (key) store.set(credentialKey("cadet", "assistant_api_key"), key);
  return {
    credentials: {
      get: async (k: string) => store.get(k),
      invalidate: () => {},
    } as CredentialCache,
  };
}

const record = {
  messageId: "<shannon-1@example.com>",
  inReplyTo: "<root@example.com>",
  references: "<root@example.com>",
  from: "shannon@example.com",
  to: "mybot@mycadet.ai",
  subject: "My cadet.ai Issue",
  text: "I was never charged.",
  timestamp: "2026-11-20T10:30:00Z",
};

describe("buildEmailReceivedRecorder", () => {
  beforeEach(() => {
    fetchCalls.length = 0;
    fetchThrows = undefined;
    fetchResponse = () => new Response("{}", { status: 200 });
    process.env.CADET_CLOUD_URL = "https://cloud.example.test/";
  });

  afterEach(() => {
    delete process.env.CADET_CLOUD_URL;
  });

  test("no credential cache — no recorder", () => {
    expect(buildEmailReceivedRecorder(undefined)).toBeUndefined();
    expect(
      buildEmailReceivedRecorder({ credentials: undefined }),
    ).toBeUndefined();
  });

  test("posts the mapped payload with the assistant api key", async () => {
    const recorder = buildEmailReceivedRecorder(makeCaches("vak-key"));
    expect(recorder).toBeDefined();
    await recorder!(record);
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0]!.url).toBe(
      "https://cloud.example.test/v1/runtime-proxy/email/received/",
    );
    const init = fetchCalls[0]!.init;
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Api-Key vak-key",
    );
    const body = JSON.parse(init.body as string);
    expect(body.message_id).toBe("<shannon-1@example.com>");
    expect(body.in_reply_to).toBe("<root@example.com>");
    expect(body.references).toBe("<root@example.com>");
    expect(body.from).toBe("shannon@example.com");
    expect(body.to).toEqual(["mybot@mycadet.ai"]);
    expect(body.subject).toBe("My cadet.ai Issue");
    expect(body.timestamp).toBe("2026-11-20T10:30:00Z");
  });

  test("CADET_CLOUD_URL unset — nothing is posted", async () => {
    delete process.env.CADET_CLOUD_URL;
    const recorder = buildEmailReceivedRecorder(makeCaches("vak-key"))!;
    await recorder(record);
    expect(fetchCalls.length).toBe(0);
  });

  test("missing api key — nothing is posted", async () => {
    const recorder = buildEmailReceivedRecorder(makeCaches(undefined))!;
    await recorder(record);
    expect(fetchCalls.length).toBe(0);
  });

  test("a non-2xx from cloud is logged, not thrown", async () => {
    fetchResponse = () => new Response("nope", { status: 503 });
    const recorder = buildEmailReceivedRecorder(makeCaches("vak-key"))!;
    await expect(recorder(record)).resolves.toBeUndefined();
    expect(fetchCalls.length).toBe(1);
  });

  test("a thrown fetch never rejects the recorder", async () => {
    fetchThrows = new Error("dns died");
    const recorder = buildEmailReceivedRecorder(makeCaches("vak-key"))!;
    await expect(recorder(record)).resolves.toBeUndefined();
  });
});
