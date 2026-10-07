import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { useMemorySecureKeyMap } from "../../../__tests__/helpers/secure-keys.js";
import { setConfig } from "../../../__tests__/helpers/set-config.js";
import { credentialKey } from "../../../security/credential-key.js";

// The REAL secure-keys module pinned to a live memory backend.
const secureKeys = useMemorySecureKeyMap();
const FASTCRW_KEY = credentialKey("fastcrw", "api_key");

function seedWebFetch(provider: string, apiBase?: string): void {
  const entry: Record<string, string> = { provider };
  if (apiBase !== undefined) {
    entry.apiBase = apiBase;
  }
  setConfig("services", { "web-fetch": entry });
}

let mockResolveAddresses: string[] = [];
const realUrlSafety = await import("../url-safety.js");
mock.module("../url-safety.js", () => ({
  ...realUrlSafety,
  resolveHostAddresses: async () => mockResolveAddresses,
}));

const { executeFastcrwScrape, webFetchTool } = await import("../web-fetch.js");

function scrapeResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("executeFastcrwScrape", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    secureKeys.delete(FASTCRW_KEY);
    mockResolveAddresses = ["93.184.216.34"];
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("hits the cloud default /v1/scrape endpoint", async () => {
    let capturedUrl = "";
    let capturedHeaders: any = null;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedHeaders = new Headers(init?.headers);
      return scrapeResponse({
        success: true,
        data: {
          markdown: "# Hello\n\nFrom fastCRW.",
          metadata: {
            title: "Example",
            url: "https://example.com/",
            statusCode: 200,
          },
        },
      });
    }) as typeof fetch;

    const result = await executeFastcrwScrape(
      { url: "https://example.com" },
      { apiKey: "crw_live_test" },
    );

    expect(result.isError).toBe(false);
    expect(capturedUrl).toBe("https://api.fastcrw.com/v1/scrape");
    expect(capturedHeaders?.get("authorization")).toBe("Bearer crw_live_test");
    expect(result.activityMetadata?.webFetch?.provider).toBe("fastcrw");
    expect(result.content).toContain("From fastCRW.");
  });

  test("uses a custom API base from config", async () => {
    seedWebFetch("fastcrw", "http://localhost:3000/");
    let capturedUrl = "";
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return scrapeResponse({
        success: true,
        data: { markdown: "local", metadata: { statusCode: 200 } },
      });
    }) as typeof fetch;

    const result = await executeFastcrwScrape(
      { url: "https://example.com" },
      { apiKey: "" },
    );

    expect(result.isError).toBe(false);
    expect(capturedUrl).toBe("http://localhost:3000/v1/scrape");
  });
});

describe("webFetchTool fastCRW dispatch", () => {
  let originalFetch: typeof globalThis.fetch;

  const execute = (input: Record<string, unknown>, ctx: any = {}) =>
    webFetchTool.execute(input, ctx);

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    secureKeys.set(FASTCRW_KEY, "crw_live_test");
    mockResolveAddresses = ["93.184.216.34"];
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("routes to fastCRW when provider=fastcrw and a key is set", async () => {
    seedWebFetch("fastcrw");
    let fastcrwHit = false;
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes("api.fastcrw.com")) {
        fastcrwHit = true;
      }
      return scrapeResponse({
        success: true,
        data: {
          markdown: "ok",
          metadata: { statusCode: 200, url: "https://example.com/" },
        },
      });
    }) as typeof fetch;

    const result = await execute({ url: "https://example.com" });
    expect(fastcrwHit).toBe(true);
    expect(result.activityMetadata?.webFetch?.provider).toBe("fastcrw");
  });

  test("routes to fastCRW without a key when a custom API base is set", async () => {
    seedWebFetch("fastcrw", "http://127.0.0.1:3000");
    secureKeys.delete(FASTCRW_KEY);
    let capturedUrl = "";
    let capturedHeaders: any = null;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedHeaders = new Headers(init?.headers);
      return scrapeResponse({
        success: true,
        data: {
          markdown: "self-host",
          metadata: { statusCode: 200, url: "https://example.com/" },
        },
      });
    }) as typeof fetch;

    const result = await execute({ url: "https://example.com" });
    expect(capturedUrl).toBe("http://127.0.0.1:3000/v1/scrape");
    expect(capturedHeaders?.get("authorization")).toBeNull();
    expect(result.activityMetadata?.webFetch?.provider).toBe("fastcrw");
  });
});
