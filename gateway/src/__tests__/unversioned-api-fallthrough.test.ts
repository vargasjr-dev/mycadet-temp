import { afterEach, describe, expect, mock, test } from "bun:test";

import "./test-preload.js";

/**
 * Pins P7 of the one-url plan against the real route table: the /v1 prefix
 * is optional at the dispatch, so both spellings resolve to the same route.
 */

type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

let fetchMock: ReturnType<typeof mock<FetchFn>> = mock(
  async () => new Response(null, { status: 200 }),
);

const actualFetch = await import("../fetch.js");
mock.module("../fetch.js", () => ({
  ...actualFetch,
  fetchImpl: (...args: Parameters<FetchFn>) => fetchMock(...args),
}));

let proxyConfig: import("../config.js").GatewayConfig;

const actualTokenExchange = await import("../auth/token-exchange.js");
mock.module("../auth/token-exchange.js", () => ({
  ...actualTokenExchange,
  validateEdgeToken: () => ({
    ok: true as const,
    claims: { sub: "svc:client", scope_profile: "actor_client_v1" },
  }),
}));

const actualConfig = await import("../config.js");
mock.module("../config.js", () => ({
  ...actualConfig,
  getConfig: () => proxyConfig,
}));

function makeConfig(): import("../config.js").GatewayConfig {
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
      slack: 50 * 1024 * 1024,
      whatsapp: 50 * 1024 * 1024,
      default: 50 * 1024 * 1024,
    },
    trustProxy: false,
  };
}

let capturedUrl: string | null = null;

const { dispatchRoute } = await import("../http/router.js");

afterEach(() => {
  fetchMock = mock(async () => new Response(null, { status: 200 }));
  capturedUrl = null;
});

function captureDials() {
  fetchMock = mock(async (input) => {
    capturedUrl = String(input);
    return new Response(null, { status: 200 });
  });
}

function serverStub() {
  return { requestIP: () => null } as never;
}

async function dispatch(
  method: string,
  path: string,
): Promise<Response | null> {
  const url = new URL(`http://gateway.local${path}`);
  const req = new Request(url, {
    method,
    headers: { authorization: "Bearer tok-edge" },
  });
  return dispatchRoute(req, url, () => "203.0.113.9", serverStub());
}

describe("unversioned api routing (P7: the /v1 prefix is optional)", () => {
  test("both spellings of a real route reach the same handler", async () => {
    // GET /ps is a real edge-authed route; the auth mock lets it through and
    // the handler dials the daemon's canonical /v1/ps either way.
    proxyConfig = makeConfig();
    captureDials();
    for (const path of ["/ps", "/v1/ps"]) {
      const res = await dispatch("GET", path);
      expect(res?.status).toBe(200);
      expect(capturedUrl).toBe("http://localhost:7821/v1/ps");
      capturedUrl = null;
    }
  });

  test("unknown paths fall through to the runtime-proxy catch-all, dial as sent", async () => {
    proxyConfig = makeConfig();
    captureDials();
    for (const path of ["/not-a-segment", "/v1/not-a-segment"]) {
      const res = await dispatch("GET", path);
      expect(res?.status).toBe(200);
      expect(capturedUrl).toBe(`http://localhost:7821${path}`);
      capturedUrl = null;
    }
  });

  test("the strip only removes one /v1 prefix", async () => {
    proxyConfig = makeConfig();
    proxyConfig = makeConfig();
    captureDials();
    // /v1/v1/ps strips once to /v1/ps, which no table route claims (route
    // paths read unversioned), so the catch-all dials it exactly as sent.
    const res = await dispatch("GET", "/v1/v1/ps");
    expect(res?.status).toBe(200);
    expect(capturedUrl).toBe("http://localhost:7821/v1/v1/ps");
  });
});
