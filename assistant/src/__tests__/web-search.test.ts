/**
 * Web search tool (Brave / Perplexity / Tavily) driven through the REAL
 * `web-search.ts` execute path: provider keys are seeded into the real
 * secure-keys module (memory backend), provider selection goes through the
 * real workspace config, and HTTP is mocked at the `globalThis.fetch`
 * boundary with `mockHttp()`.
 *
 * This file used to inline-copy the tool's execute logic (three providers'
 * worth of duplicated formatting/retry code) and test the copy; it now tests
 * the production module so drift fails here instead of shipping.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { credentialKey } from "../security/credential-key.js";
import { WEB_SEARCH_BACKEND_FAILURE_MESSAGE } from "../tools/network/web-search-error.js";
import { useMemorySecureKeys } from "./helpers/secure-keys.js";
import { setConfig } from "./helpers/set-config.js";
import { mockHttp } from "./requests-mock.js";

const keyStore = useMemorySecureKeys({
  [credentialKey("brave", "api_key")]: "brave-key",
  [credentialKey("perplexity", "api_key")]: "pplx-key",
  [credentialKey("tavily", "api_key")]: "tvly-key",
});

const { webSearchTool } = await import("../tools/network/web-search.js");

type Provider = "brave" | "perplexity" | "tavily";

async function executeWebSearch(
  input: Record<string, unknown>,
  provider: Provider,
) {
  setConfig("services", { "web-search": { provider } });
  return webSearchTool.execute(input, {} as never);
}

beforeEach(() => {
  // Fresh keys per test — no-key tests clear the store for their duration
  // and every test starts with all three providers seeded.
  for (const [service, value] of Object.entries({
    brave: "brave-key",
    perplexity: "pplx-key",
    tavily: "tvly-key",
  })) {
    keyStore[credentialKey(service, "api_key")] = value;
  }
});

describe("WebSearchTool", () => {
  describe("API key resolution", () => {
    test("returns error when no API key is configured (brave)", async () => {
      for (const key of Object.keys(keyStore)) {
        delete keyStore[key];
      }
      const http = mockHttp();

      const result = await executeWebSearch({ query: "test" }, "brave");
      expect(result.isError).toBe(true);
      expect(result.content).toContain("No web search API key configured");
      // No key anywhere in the fallback chain — nothing is called.
      expect(http.callCount()).toBe(0);
    });

    test("returns error when no API key is configured (perplexity)", async () => {
      for (const key of Object.keys(keyStore)) {
        delete keyStore[key];
      }
      const http = mockHttp();

      const result = await executeWebSearch({ query: "test" }, "perplexity");
      expect(result.isError).toBe(true);
      expect(result.content).toContain("No web search API key configured");
      expect(http.callCount()).toBe(0);
    });

    test("returns error when no API key is configured (tavily)", async () => {
      for (const key of Object.keys(keyStore)) {
        delete keyStore[key];
      }
      const http = mockHttp();

      const result = await executeWebSearch({ query: "test" }, "tavily");
      expect(result.isError).toBe(true);
      expect(result.content).toContain("No web search API key configured");
      expect(http.callCount()).toBe(0);
    });
  });

  describe("input validation", () => {
    test("rejects missing query", async () => {
      const http = mockHttp();

      const result = await executeWebSearch({}, "brave");
      expect(result.isError).toBe(true);
      expect(result.content).toContain("query is required");
      expect(http.callCount()).toBe(0);
    });

    test("rejects non-string query", async () => {
      const http = mockHttp();

      const result = await executeWebSearch({ query: 123 }, "brave");
      expect(result.isError).toBe(true);
      expect(result.content).toContain("query is required");
      expect(http.callCount()).toBe(0);
    });
  });

  describe("Brave parameter handling", () => {
    test("clamps count to valid range", async () => {
      const http = mockHttp();
      http.on("api.search.brave.com", {
        status: 200,
        body: { web: { results: [] } },
      });

      await executeWebSearch({ query: "test", count: 50 }, "brave");
      expect(http.lastCall()?.url).toContain("count=20");

      await executeWebSearch({ query: "test", count: -5 }, "brave");
      expect(http.lastCall()?.url).toContain("count=1");
    });

    test("clamps offset to valid range", async () => {
      const http = mockHttp();
      http.on("api.search.brave.com", {
        status: 200,
        body: { web: { results: [] } },
      });

      await executeWebSearch({ query: "test", offset: 20 }, "brave");
      expect(http.lastCall()?.url).toContain("offset=9");
    });

    test("includes freshness when valid", async () => {
      const http = mockHttp();
      http.on("api.search.brave.com", {
        status: 200,
        body: { web: { results: [] } },
      });

      await executeWebSearch({ query: "test", freshness: "pw" }, "brave");
      expect(http.lastCall()?.url).toContain("freshness=pw");
    });

    test("ignores invalid freshness values", async () => {
      const http = mockHttp();
      http.on("api.search.brave.com", {
        status: 200,
        body: { web: { results: [] } },
      });

      await executeWebSearch({ query: "test", freshness: "invalid" }, "brave");
      expect(http.lastCall()?.url).not.toContain("freshness");
    });
  });

  describe("Brave API responses", () => {
    test("formats results correctly", async () => {
      const http = mockHttp();
      http.on("api.search.brave.com", {
        status: 200,
        body: {
          web: {
            results: [
              {
                title: "Test Result",
                url: "https://example.com",
                description: "A test result",
              },
              {
                title: "Another Result",
                url: "https://other.com",
                description: "Another one",
                age: "2 days ago",
              },
            ],
          },
        },
      });

      const result = await executeWebSearch({ query: "test" }, "brave");
      expect(result.isError).toBe(false);
      expect(result.content).toContain("Test Result");
      expect(result.content).toContain("https://example.com");
      expect(result.content).toContain("A test result");
      expect(result.content).toContain("Another Result");
      expect(result.content).toContain("2 days ago");
    });

    test("handles empty results", async () => {
      const http = mockHttp();
      http.on("api.search.brave.com", {
        status: 200,
        body: { web: { results: [] } },
      });

      const result = await executeWebSearch({ query: "noresults" }, "brave");
      expect(result.isError).toBe(false);
      expect(result.content).toContain("No results found");
    });

    test("handles missing web field", async () => {
      const http = mockHttp();
      http.on("api.search.brave.com", { status: 200, body: {} });

      const result = await executeWebSearch({ query: "empty" }, "brave");
      expect(result.isError).toBe(false);
      expect(result.content).toContain("No results found");
    });

    test("handles 401 unauthorized", async () => {
      const http = mockHttp();
      http.on("api.search.brave.com", { status: 401, body: "Unauthorized" });

      const result = await executeWebSearch({ query: "test" }, "brave");
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Invalid or expired");
    });

    test("retries on 429 and succeeds", async () => {
      const http = mockHttp();
      http.on("api.search.brave.com", [
        {
          status: 429,
          body: "Too Many Requests",
          headers: { "Retry-After": "0" },
        },
        {
          status: 429,
          body: "Too Many Requests",
          headers: { "Retry-After": "0" },
        },
        {
          status: 200,
          body: {
            web: {
              results: [
                {
                  title: "Result",
                  url: "https://example.com",
                  description: "Found it",
                },
              ],
            },
          },
        },
      ]);

      const result = await executeWebSearch({ query: "test" }, "brave");
      expect(result.isError).toBe(false);
      expect(result.content).toContain("Found it");
      expect(http.callCount()).toBe(3);
    });

    test("returns the friendly backend copy after exhausting 429 retries", async () => {
      const http = mockHttp();
      http.on("api.search.brave.com", {
        status: 429,
        body: "Too Many Requests",
        headers: { "Retry-After": "0" },
      });

      const result = await executeWebSearch({ query: "test" }, "brave");
      expect(result.isError).toBe(true);
      expect(result.content).toBe(WEB_SEARCH_BACKEND_FAILURE_MESSAGE);
      // DEFAULT_MAX_RETRIES = 3 → the initial attempt plus three retries.
      expect(http.callCount()).toBe(4);
    });

    test("respects Retry-After header on 429", async () => {
      const http = mockHttp();
      http.on("api.search.brave.com", [
        {
          status: 429,
          body: "Too Many Requests",
          headers: { "Retry-After": "0" },
        },
        { status: 200, body: { web: { results: [] } } },
      ]);

      const result = await executeWebSearch({ query: "test" }, "brave");
      expect(result.isError).toBe(false);
      expect(http.callCount()).toBe(2);
    });

    test("surfaces the friendly backend copy on network errors", async () => {
      const http = mockHttp();
      http.on("api.search.brave.com", new TypeError("fetch failed"));

      const result = await executeWebSearch({ query: "test" }, "brave");
      expect(result.isError).toBe(true);
      expect(result.content).toBe(WEB_SEARCH_BACKEND_FAILURE_MESSAGE);
      expect(http.callCount()).toBe(1);
    });

    test("sends correct headers", async () => {
      const http = mockHttp();
      http.on("api.search.brave.com", {
        status: 200,
        body: { web: { results: [] } },
      });

      await executeWebSearch({ query: "test" }, "brave");
      const req = http.lastCall();
      expect(req?.headers["X-Subscription-Token"]).toBe("brave-key");
      expect(req?.headers["Accept"]).toBe("application/json");
    });

    test("includes extra_snippets in output", async () => {
      const http = mockHttp();
      http.on("api.search.brave.com", {
        status: 200,
        body: {
          web: {
            results: [
              {
                title: "Snippet Test",
                url: "https://example.com",
                description: "Main description",
                extra_snippets: ["Extra snippet 1", "Extra snippet 2"],
              },
            ],
          },
        },
      });

      const result = await executeWebSearch({ query: "test" }, "brave");
      expect(result.isError).toBe(false);
      expect(result.content).toContain("Extra snippet 1");
      expect(result.content).toContain("Extra snippet 2");
    });
  });

  describe("Perplexity API responses", () => {
    test("formats results with citations", async () => {
      const http = mockHttp();
      http.on("api.perplexity.ai", {
        status: 200,
        body: {
          choices: [
            {
              message: {
                content: "Perplexity found this information about the topic.",
              },
            },
          ],
          citations: [
            "https://example.com/source1",
            "https://example.com/source2",
          ],
        },
      });

      const result = await executeWebSearch({ query: "test" }, "perplexity");
      expect(result.isError).toBe(false);
      expect(result.content).toContain("Perplexity found this information");
      expect(result.content).toContain("https://example.com/source1");
      expect(result.content).toContain("https://example.com/source2");
    });

    test("handles empty response", async () => {
      const http = mockHttp();
      http.on("api.perplexity.ai", {
        status: 200,
        body: { choices: [{ message: { content: "" } }] },
      });

      const result = await executeWebSearch(
        { query: "noresults" },
        "perplexity",
      );
      expect(result.isError).toBe(false);
      expect(result.content).toContain("No results found");
    });

    test("handles 401 unauthorized", async () => {
      const http = mockHttp();
      http.on("api.perplexity.ai", { status: 401, body: "Unauthorized" });

      const result = await executeWebSearch({ query: "test" }, "perplexity");
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Invalid or expired");
    });

    test("sends correct headers and body", async () => {
      const http = mockHttp();
      http.on("api.perplexity.ai", {
        status: 200,
        body: { choices: [{ message: { content: "result" } }] },
      });

      await executeWebSearch({ query: "test query" }, "perplexity");
      const req = http.lastCall();
      expect(req?.headers["Authorization"]).toBe("Bearer pplx-key");
      expect(req?.headers["Content-Type"]).toBe("application/json");
      const body = req?.body as {
        model: string;
        messages: Array<{ content: string }>;
      };
      expect(body.model).toBe("sonar");
      expect(body.messages[0]?.content).toBe("test query");
    });

    test("retries on 429 and succeeds", async () => {
      const http = mockHttp();
      http.on("api.perplexity.ai", [
        {
          status: 429,
          body: "Too Many Requests",
          headers: { "Retry-After": "0" },
        },
        {
          status: 429,
          body: "Too Many Requests",
          headers: { "Retry-After": "0" },
        },
        {
          status: 200,
          body: { choices: [{ message: { content: "Found it" } }] },
        },
      ]);

      const result = await executeWebSearch({ query: "test" }, "perplexity");
      expect(result.isError).toBe(false);
      expect(result.content).toContain("Found it");
      expect(http.callCount()).toBe(3);
    });

    test("surfaces the friendly backend copy on network errors", async () => {
      const http = mockHttp();
      http.on("api.perplexity.ai", new TypeError("fetch failed"));

      const result = await executeWebSearch({ query: "test" }, "perplexity");
      expect(result.isError).toBe(true);
      expect(result.content).toBe(WEB_SEARCH_BACKEND_FAILURE_MESSAGE);
      expect(http.callCount()).toBe(1);
    });
  });

  describe("Tavily API responses", () => {
    test("formats results", async () => {
      const http = mockHttp();
      http.on("api.tavily.com", {
        status: 200,
        body: {
          results: [
            {
              title: "Tavily Result",
              url: "https://example.com/tavily",
              content: "A Tavily search snippet.",
              score: 0.9234,
            },
          ],
        },
      });

      const result = await executeWebSearch({ query: "test" }, "tavily");
      expect(result.isError).toBe(false);
      expect(result.content).toContain("Tavily Result");
      expect(result.content).toContain("https://example.com/tavily");
      expect(result.content).toContain("A Tavily search snippet");
      expect(result.content).toContain("Score: 0.923");
    });

    test("handles empty response", async () => {
      const http = mockHttp();
      http.on("api.tavily.com", { status: 200, body: { results: [] } });

      const result = await executeWebSearch({ query: "noresults" }, "tavily");
      expect(result.isError).toBe(false);
      expect(result.content).toContain("No results found");
    });

    test("maps count and freshness into the Tavily request body", async () => {
      const http = mockHttp();
      http.on("api.tavily.com", { status: 200, body: { results: [] } });

      await executeWebSearch(
        { query: "test query", count: 50, freshness: "pw" },
        "tavily",
      );
      const req = http.lastCall();
      expect(req?.headers.Authorization).toBe("Bearer tvly-key");
      expect(req?.headers["Content-Type"]).toBe("application/json");
      const body = req?.body as Record<string, unknown>;
      expect(body.query).toBe("test query");
      expect(body.search_depth).toBe("advanced");
      expect(body.max_results).toBe(20);
      expect(body.time_range).toBe("week");
    });

    test("omits invalid freshness values", async () => {
      const http = mockHttp();
      http.on("api.tavily.com", { status: 200, body: { results: [] } });

      await executeWebSearch(
        { query: "test query", freshness: "invalid" },
        "tavily",
      );
      const body = http.lastCall()?.body as Record<string, unknown>;
      expect(body.time_range).toBeUndefined();
    });

    test("handles 401 unauthorized", async () => {
      const http = mockHttp();
      http.on("api.tavily.com", { status: 401, body: "Unauthorized" });

      const result = await executeWebSearch({ query: "test" }, "tavily");
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Invalid or expired");
    });

    test("retries on 429 and succeeds", async () => {
      const http = mockHttp();
      http.on("api.tavily.com", [
        {
          status: 429,
          body: "Too Many Requests",
          headers: { "Retry-After": "0" },
        },
        {
          status: 429,
          body: "Too Many Requests",
          headers: { "Retry-After": "0" },
        },
        {
          status: 200,
          body: {
            results: [
              {
                title: "Found it",
                url: "https://example.com/found",
                content: "Found it with Tavily",
              },
            ],
          },
        },
      ]);

      const result = await executeWebSearch({ query: "test" }, "tavily");
      expect(result.isError).toBe(false);
      expect(result.content).toContain("Found it with Tavily");
      expect(http.callCount()).toBe(3);
    });

    test("surfaces the friendly backend copy on network errors", async () => {
      const http = mockHttp();
      http.on("api.tavily.com", new TypeError("fetch failed"));

      const result = await executeWebSearch({ query: "test" }, "tavily");
      expect(result.isError).toBe(true);
      expect(result.content).toBe(WEB_SEARCH_BACKEND_FAILURE_MESSAGE);
      expect(http.callCount()).toBe(1);
    });
  });
});
