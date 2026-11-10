/**
 * Pins the runtime-proxy catch-all's verb coverage at the ROUTER level.
 *
 * The row is the gateway's fall-through for every daemon surface it doesn't
 * specifically mirror, and daemon traffic is mostly POST (sends, steering,
 * deletes) — a method restriction on the row strands every non-GET dial on
 * the router's 404 while GETs sail through. The #751 routes-table refactor
 * briefly did exactly that; this file keeps the row method-agnostic.
 */

import { describe, expect, test, mock, afterEach } from "bun:test";
import type { GatewayConfig } from "../config.js";

import "./test-preload.js";

type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
let fetchMock: ReturnType<typeof mock<FetchFn>> = mock(
  async () => new Response(),
);

const actualFetch = await import("../fetch.js");
mock.module("../fetch.js", () => ({
  ...actualFetch,
  fetchImpl: (...args: Parameters<FetchFn>) => fetchMock(...args),
}));

let proxyConfig: GatewayConfig;

const actualConfig = await import("../config.js");
mock.module("../config.js", () => ({
  ...actualConfig,
  getConfig: () => proxyConfig,
}));

const { AuthRateLimiter } = await import("../auth-rate-limiter.js");
const { createRouter } = await import("../http/router.js");
const { ROUTES } = await import("../http/routes/index.js");

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    assistantRuntimeBaseUrl: "http://localhost:7821",
    routingEntries: [],
    port: 7830,
    runtimeProxyRequireAuth: false,
    runtimeTimeoutMs: 30000,
    maxAttachmentConcurrency: 3,
    runtimeMaxRetries: 2,
    runtimeInitialBackoffMs: 500,
    maxWebhookPayloadBytes: 1048576,
    logFile: { dir: undefined, retentionDays: 30 },
    maxAttachmentBytes: {
      telegram: 50 * 1024 * 1024,
      slack: 100 * 1024 * 1024,
      whatsapp: 16 * 1024 * 1024,
      default: 50 * 1024 * 1024,
    },
    trustProxy: false,
    ...overrides,
  };
}

let capturedUrl: string | null = null;

afterEach(() => {
  fetchMock = mock(async () => new Response());
  capturedUrl = null;
});

function makeRouter(): ReturnType<typeof createRouter> {
  return createRouter(ROUTES, { authRateLimiter: new AuthRateLimiter() });
}

describe("the runtime-proxy catch-all serves every verb", () => {
  test("a POST the table doesn't mirror forwards to the daemon's flat path", async () => {
    proxyConfig = makeConfig();
    fetchMock = mock(async (input) => {
      capturedUrl = String(input);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const url = new URL(
      "http://gateway.local/v1/assistants/clear-bat-gzpuwp/messages",
    );
    const response = await makeRouter()(
      new Request(url, {
        method: "POST",
        body: JSON.stringify({ conversationId: "conv-1" }),
        headers: { "content-type": "application/json" },
      }),
      url,
      () => "203.0.113.9",
    );

    // The dispatch reached the proxy (not the router's 404 miss) and the
    // assistant-scoped spelling flattened onto the daemon's flat surface.
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    expect(capturedUrl).toBe("http://localhost:7821/v1/messages");
  });

  test("a DELETE falls through the same way", async () => {
    proxyConfig = makeConfig();
    fetchMock = mock(async (input) => {
      capturedUrl = String(input);
      return new Response(null, { status: 204 });
    });

    const url = new URL(
      "http://gateway.local/v1/assistants/clear-bat-gzpuwp/messages/queued/q-1",
    );
    const response = await makeRouter()(
      new Request(url, { method: "DELETE" }),
      url,
      () => "203.0.113.9",
    );

    expect(response).not.toBeNull();
    expect(response!.status).toBe(204);
    expect(capturedUrl).toBe(
      "http://localhost:7821/v1/messages/queued/q-1",
    );
  });

  test("a GET keeps falling through (the spelling the web has always used)", async () => {
    proxyConfig = makeConfig();
    fetchMock = mock(async (input) => {
      capturedUrl = String(input);
      return new Response(JSON.stringify({ messages: [] }), { status: 200 });
    });

    const url = new URL(
      "http://gateway.local/v1/assistants/clear-bat-gzpuwp/messages?conversationId=conv-1",
    );
    const response = await makeRouter()(
      new Request(url, { method: "GET" }),
      url,
      () => "203.0.113.9",
    );

    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    expect(capturedUrl).toBe(
      "http://localhost:7821/v1/messages?conversationId=conv-1",
    );
  });
});
