import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { GatewayConfig } from "../../config.js";

// --- Mocks -------------------------------------------------------------------

let capturedFetchHeaders: Headers | undefined;
let capturedFetchUrl: string | undefined;
let fetchResponse = new Response(JSON.stringify({ ok: true }), { status: 200 });

mock.module("../../fetch.js", () => ({
  fetchImpl: async (url: string | URL | Request, init?: RequestInit) => {
    capturedFetchUrl = String(url);
    capturedFetchHeaders = new Headers(init?.headers as HeadersInit);
    return fetchResponse;
  },
}));

// Spread the actual module so untouched exports stay
// importable by transitive dependencies of the modules under test.
const actualPaths = await import("../../paths.js");
mock.module("../../paths.js", () => ({
  ...actualPaths,
  getGatewaySecurityDir: () => "/tmp/test-gateway-sec",
  getWorkspaceDir: () => "/tmp/test-workspace",
}));

mock.module("../../auth/guardian-bootstrap.js", () => ({
  bootstrapGuardian: () => ({
    guardianPrincipalId: "cadet-principal-test",
    accessToken: "test-at",
    accessTokenExpiresAt: Date.now() + 86400_000,
    refreshToken: "test-rt",
    refreshTokenExpiresAt: Date.now() + 86400_000 * 30,
    refreshAfter: Date.now() + 86400_000 * 15,
    isNew: true,
  }),
  closeAssistantDb: () => {},
  getAssistantDb: () => null,
  getExternalAssistantId: () => "test-assistant",
  hashToken: (t: string) => t,
  ACCESS_TOKEN_TTL_SECONDS: 30 * 24 * 60 * 60,
  ACCESS_TOKEN_TTL_MS: 30 * 24 * 60 * 60 * 1000,
  REFRESH_ABSOLUTE_TTL_MS: 365 * 24 * 60 * 60 * 1000,
  REFRESH_INACTIVITY_TTL_MS: 90 * 24 * 60 * 60 * 1000,
  REFRESH_AFTER_FRACTION: 0.8,
}));

// Import after mocks are registered
const { createChannelVerificationSessionProxyHandler } =
  await import("./channel-verification-session-proxy.js");

// --- Helpers -----------------------------------------------------------------

function makeConfig(overrides?: Partial<GatewayConfig>): GatewayConfig {
  return {
    assistantRuntimeBaseUrl: "http://localhost:7821",
    runtimeTimeoutMs: 30_000,
    ...overrides,
  } as GatewayConfig;
}

// --- Tests -------------------------------------------------------------------

describe("channel-verification-session-proxy x-forwarded-for handling", () => {
  beforeEach(() => {
    capturedFetchHeaders = undefined;
    capturedFetchUrl = undefined;
    fetchResponse = new Response(JSON.stringify({ ok: true }), { status: 200 });
  });

  it("strips x-forwarded-for for loopback client IP", async () => {
    const config = makeConfig();
    const handler = createChannelVerificationSessionProxyHandler(config);

    const req = new Request("http://gateway/v1/channel-verification-sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "should-be-stripped",
      },
      body: JSON.stringify({ channel: "test" }),
    });

    // proxyToRuntime is called without clientIp from handleCreateVerificationSession,
    // so x-forwarded-for should be stripped
    await handler.handleCreateVerificationSession(req);

    expect(capturedFetchHeaders).toBeDefined();
    expect(capturedFetchHeaders!.has("x-forwarded-for")).toBe(false);
  });

  it("asserts the gateway service identity in x-cadet-* headers", async () => {
    const config = makeConfig();
    const handler = createChannelVerificationSessionProxyHandler(config);

    const req = new Request("http://gateway/v1/channel-verification-sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: "test" }),
    });

    await handler.handleCreateVerificationSession(req);

    expect(capturedFetchHeaders).toBeDefined();
    // The daemon verifies no tokens — the proxy asserts the gateway's
    // service identity in x-cadet-* headers, never a bearer.
    expect(capturedFetchHeaders!.get("authorization")).toBeNull();
    expect(capturedFetchHeaders!.get("x-cadet-subject")).toBe(
      "svc:gateway:self",
    );
    expect(capturedFetchHeaders!.get("x-cadet-scope-profile")).toBe(
      "gateway_service_v1",
    );
  });

  it("forwards query params for status endpoint", async () => {
    const config = makeConfig();
    const handler = createChannelVerificationSessionProxyHandler(config);

    const req = new Request(
      "http://gateway/v1/channel-verification-sessions/status?channel=telegram&id=123",
      { method: "GET" },
    );

    await handler.handleGetVerificationStatus(req);

    expect(capturedFetchUrl).toBeDefined();
    expect(capturedFetchUrl).toContain(
      "/v1/channel-verification-sessions/status",
    );
    expect(capturedFetchUrl).toContain("channel=telegram");
    expect(capturedFetchUrl).toContain("id=123");
  });

  it("strips hop-by-hop headers from forwarded request", async () => {
    const config = makeConfig();
    const handler = createChannelVerificationSessionProxyHandler(config);

    const req = new Request("http://gateway/v1/channel-verification-sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        connection: "keep-alive",
        "keep-alive": "timeout=5",
      },
      body: JSON.stringify({ channel: "test" }),
    });

    await handler.handleCreateVerificationSession(req);

    expect(capturedFetchHeaders).toBeDefined();
    expect(capturedFetchHeaders!.has("connection")).toBe(false);
    expect(capturedFetchHeaders!.has("keep-alive")).toBe(false);
    expect(capturedFetchHeaders!.get("content-type")).toBe("application/json");
  });

  it("removes incoming host and authorization headers", async () => {
    const config = makeConfig();
    const handler = createChannelVerificationSessionProxyHandler(config);

    const req = new Request("http://gateway/v1/channel-verification-sessions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "gateway.example.com",
        authorization: "Bearer old-edge-token",
      },
      body: JSON.stringify({ channel: "test" }),
    });

    await handler.handleCreateVerificationSession(req);

    expect(capturedFetchHeaders).toBeDefined();
    expect(capturedFetchHeaders!.has("host")).toBe(false);
    // Neither the caller's edge token nor any bearer survives the hop;
    // the gateway's service identity rides in x-cadet-* headers.
    expect(capturedFetchHeaders!.get("authorization")).toBeNull();
    expect(capturedFetchHeaders!.get("x-cadet-subject")).toBe(
      "svc:gateway:self",
    );
  });
});
