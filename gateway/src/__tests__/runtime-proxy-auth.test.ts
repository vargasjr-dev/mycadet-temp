import { describe, test, expect, mock, afterEach } from "bun:test";
import type { GatewayConfig } from "../config.js";
import { initSigningKey, mintToken } from "../auth/token-service.js";
import { CURRENT_POLICY_EPOCH } from "../auth/policy.js";

type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
let fetchMock: ReturnType<typeof mock<FetchFn>> = mock(
  async () => new Response(),
);

mock.module("../fetch.js", () => ({
  fetchImpl: (...args: Parameters<FetchFn>) => fetchMock(...args),
}));

const { createRuntimeProxyHandler } =
  await import("../http/routes/runtime-proxy.js");

const TEST_SIGNING_KEY = Buffer.from("test-signing-key-at-least-32-bytes-long");
initSigningKey(TEST_SIGNING_KEY);

/** Mint a valid edge JWT (aud=cadet-gateway) for test requests. */
function mintEdgeToken(): string {
  return mintToken({
    aud: "cadet-gateway",
    sub: "actor:test-assistant:test-user",
    scope_profile: "actor_client_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds: 300,
  });
}

const TOKEN = mintEdgeToken();

function makeConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const merged: GatewayConfig = {
    assistantRuntimeBaseUrl: "http://localhost:7821",
    routingEntries: [],
    port: 7830,
    runtimeProxyRequireAuth: true,
    runtimeTimeoutMs: 30000,
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
    maxAttachmentConcurrency: 3,
    gatewayInternalBaseUrl: "http://127.0.0.1:7830",
    trustProxy: false,
    ...overrides,
  };
  return merged;
}

afterEach(() => {
  fetchMock = mock(async () => new Response());
});

function mockUpstream() {
  fetchMock = mock(async () => {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

describe("runtime proxy auth enforcement", () => {
  test("auth required: rejects missing token with 401", async () => {
    mockUpstream();
    const handler = createRuntimeProxyHandler(makeConfig());
    const req = new Request("http://localhost:7830/v1/health");
    const res = await handler(req);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  test("auth required: rejects invalid token with 401", async () => {
    mockUpstream();
    const handler = createRuntimeProxyHandler(makeConfig());
    const req = new Request("http://localhost:7830/v1/health", {
      headers: { authorization: "Bearer wrong-token" },
    });
    const res = await handler(req);

    expect(res.status).toBe(401);
  });

  test("auth required: accepts valid token and proxies", async () => {
    mockUpstream();
    const handler = createRuntimeProxyHandler(makeConfig());
    const req = new Request("http://localhost:7830/v1/health", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const res = await handler(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test("auth required: forwards the verified identity without the client's edge token", async () => {
    let capturedHeaders: Headers | undefined;
    fetchMock = mock(
      async (_input: string | URL | Request, init?: RequestInit) => {
        capturedHeaders = init?.headers as unknown as Headers;
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );

    const handler = createRuntimeProxyHandler(makeConfig());
    const req = new Request("http://localhost:7830/v1/health", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    await handler(req);

    // The daemon verifies no tokens — the gateway forwards the verified
    // identity in x-cadet-* headers, and the client's edge bearer never
    // survives the hop.
    const identity = forwardedIdentity(capturedHeaders!);
    expect(identity.subject).toBe("actor:self:test-user");
    expect(identity.principalType).toBe("actor");
    expect(identity.scopeProfile).toBe("actor_client_v1");
  });

  test("auth not required: proxies without token", async () => {
    mockUpstream();
    const handler = createRuntimeProxyHandler(
      makeConfig({ runtimeProxyRequireAuth: false }),
    );
    const req = new Request("http://localhost:7830/v1/health");
    const res = await handler(req);

    expect(res.status).toBe(200);
  });

  test("OPTIONS request bypasses auth", async () => {
    mockUpstream();
    const handler = createRuntimeProxyHandler(makeConfig());
    const req = new Request("http://localhost:7830/v1/health", {
      method: "OPTIONS",
    });
    const res = await handler(req);

    expect(res.status).toBe(200);
  });
});

// =========================================================================
// The OAuth passthrough grant, against a gateway that requires no client auth
//
// `assistant oauth proxy-url` hands a third-party binary a URL and a grant.
// The daemon's passthrough route authorizes on the grant's own subject and
// `oauth.proxy` scope, so the grant has to survive this hop as itself: a
// service token names neither and the route answers 403.
// =========================================================================

/** The subject `oauth_proxy_grant` mints for a grant pinned to one provider. */
const PROXY_GRANT_SUB = "local:self:oauth-proxy.stripe_link";

function mintProxyGrant(): string {
  return mintToken({
    aud: "cadet-gateway",
    sub: PROXY_GRANT_SUB,
    scope_profile: "oauth_proxy_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds: 300,
  });
}

const NO_AUTH_CONFIG = () => makeConfig({ runtimeProxyRequireAuth: false });

/** Run one proxied request and return the headers it sent upstream. */
async function forwardedHeaders(
  config: GatewayConfig,
  init?: RequestInit,
): Promise<Headers> {
  let captured: Headers | undefined;
  fetchMock = mock(
    async (_input: string | URL | Request, requestInit?: RequestInit) => {
      captured = requestInit?.headers as unknown as Headers;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  );
  await createRuntimeProxyHandler(config)(
    new Request("http://localhost:7830/v1/oauth/proxy/stripe_link/v1/me", init),
  );
  return captured!;
}

/**
 * The forwarded identity the proxy asserted upstream. The daemon verifies no
 * tokens — the identity rides in `x-cadet-*` headers, and a caller's bearer
 * must never survive the hop.
 */
function forwardedIdentity(headers: Headers): {
  subject: string | null;
  principalType: string | null;
  scopeProfile: string | null;
} {
  expect(headers.get("authorization")).toBeNull();
  return {
    subject: headers.get("x-cadet-subject"),
    principalType: headers.get("x-cadet-principal-type"),
    scopeProfile: headers.get("x-cadet-scope-profile"),
  };
}

describe("runtime proxy without client-facing auth", () => {
  test("exchanges a presented proxy grant with its subject and profile", async () => {
    const headers = await forwardedHeaders(NO_AUTH_CONFIG(), {
      headers: { authorization: `Bearer ${mintProxyGrant()}` },
    });

    const identity = forwardedIdentity(headers);
    expect(identity.subject).toBe(PROXY_GRANT_SUB);
    expect(identity.principalType).toBe("local");
    expect(identity.scopeProfile).toBe("oauth_proxy_v1");
  });

  test("asserts the service identity when no bearer is presented", async () => {
    const headers = await forwardedHeaders(NO_AUTH_CONFIG());

    const identity = forwardedIdentity(headers);
    expect(identity.subject).toBe("svc:gateway:self");
    expect(identity.principalType).toBe("svc_gateway");
    expect(identity.scopeProfile).toBe("gateway_service_v1");
  });

  test("asserts the service identity for a grant this install never signed", async () => {
    // The bearer is the shape of a grant and carries no valid signature.
    // Auth being off makes a bearer optional, not an unsigned one credible.
    const forged = `${mintProxyGrant()}tampered`;
    const headers = await forwardedHeaders(NO_AUTH_CONFIG(), {
      headers: { authorization: `Bearer ${forged}` },
    });

    const identity = forwardedIdentity(headers);
    expect(identity.subject).toBe("svc:gateway:self");
    expect(identity.scopeProfile).toBe("gateway_service_v1");
  });

  test("asserts the service identity for an expired grant", async () => {
    const expired = mintToken({
      aud: "cadet-gateway",
      sub: PROXY_GRANT_SUB,
      scope_profile: "oauth_proxy_v1",
      policy_epoch: CURRENT_POLICY_EPOCH,
      ttlSeconds: -1,
    });
    const headers = await forwardedHeaders(NO_AUTH_CONFIG(), {
      headers: { authorization: `Bearer ${expired}` },
    });

    const identity = forwardedIdentity(headers);
    expect(identity.subject).toBe("svc:gateway:self");
    expect(identity.scopeProfile).toBe("gateway_service_v1");
  });

  test("leaves a broad edge token on the service-token path", async () => {
    // Only the single-route grant is carried through: a broad token reaching
    // the daemon as its own actor principal would hold scopes (admin.write)
    // the service token does not.
    const headers = await forwardedHeaders(NO_AUTH_CONFIG(), {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    const identity = forwardedIdentity(headers);
    expect(identity.subject).toBe("svc:gateway:self");
    expect(identity.scopeProfile).toBe("gateway_service_v1");
  });

  test("exchanges the same grant identically when auth is required", async () => {
    const grant = `Bearer ${mintProxyGrant()}`;
    const withoutAuth = forwardedIdentity(
      await forwardedHeaders(NO_AUTH_CONFIG(), {
        headers: { authorization: grant },
      }),
    );
    const withAuth = forwardedIdentity(
      await forwardedHeaders(makeConfig(), {
        headers: { authorization: grant },
      }),
    );

    expect(withoutAuth.subject).toBe(withAuth.subject);
    expect(withoutAuth.scopeProfile).toBe(withAuth.scopeProfile);
  });
});

// =========================================================================
// Host-absolute provider paths (CAS-159)
//
// A minted grant base is `/v1/oauth/proxy/<segment>`. Stock clients resolve
// `/upload/gmail/...` against the origin, so the catch-all used to forward
// that path to the daemon unchanged (no handler). The rewrite prefixes the
// grant's segment and leaves body and Content-Type untouched.
// =========================================================================

const GOOGLE_PROXY_SUB = "local:self:oauth-proxy.google";

function mintGoogleProxyGrant(): string {
  return mintToken({
    aud: "cadet-gateway",
    sub: GOOGLE_PROXY_SUB,
    scope_profile: "oauth_proxy_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds: 300,
  });
}

async function forwardedUpstream(
  path: string,
  init: RequestInit,
): Promise<{ url: string; init: RequestInit | undefined }> {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  fetchMock = mock(
    async (input: string | URL | Request, requestInit?: RequestInit) => {
      capturedUrl = String(input);
      capturedInit = requestInit;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  );
  const res = await createRuntimeProxyHandler(NO_AUTH_CONFIG())(
    new Request(`http://localhost:7830${path}`, init),
  );
  expect(res.status).toBe(200);
  return { url: capturedUrl, init: capturedInit };
}

describe("runtime proxy OAuth grant path rewrite", () => {
  test("forwards a host-absolute Gmail upload path onto the google proxy prefix", async () => {
    const rfc822 =
      "From: user@example.com\r\nTo: user@example.com\r\nSubject: Draft\r\n\r\nHello\r\n";
    const { url, init } = await forwardedUpstream(
      "/upload/gmail/v1/users/me/drafts?uploadType=media",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${mintGoogleProxyGrant()}`,
          "content-type": "message/rfc822",
        },
        body: rfc822,
      },
    );

    expect(url).toBe(
      "http://localhost:7821/v1/oauth/proxy/google/upload/gmail/v1/users/me/drafts?uploadType=media",
    );
    const headers = init?.headers as Headers;
    expect(headers.get("content-type")).toBe("message/rfc822");
    expect(new TextDecoder().decode(init?.body as ArrayBuffer)).toBe(rfc822);
  });

  test("preserves a multipart/related body and boundary on the rewritten path", async () => {
    const boundary = "boundary_cas159";
    const body =
      `--${boundary}\r\n` +
      "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
      '{"message":{"id":"draft-1"}}\r\n' +
      `--${boundary}\r\n` +
      "Content-Type: message/rfc822\r\n\r\n" +
      "From: user@example.com\r\nSubject: Draft\r\n\r\nHi\r\n" +
      `--${boundary}--`;
    const contentType = `multipart/related; boundary=${boundary}`;
    const { url, init } = await forwardedUpstream(
      "/upload/gmail/v1/users/me/drafts?uploadType=multipart",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${mintGoogleProxyGrant()}`,
          "content-type": contentType,
        },
        body,
      },
    );

    expect(url).toBe(
      "http://localhost:7821/v1/oauth/proxy/google/upload/gmail/v1/users/me/drafts?uploadType=multipart",
    );
    const headers = init?.headers as Headers;
    expect(headers.get("content-type")).toBe(contentType);
    expect(new TextDecoder().decode(init?.body as ArrayBuffer)).toBe(body);
  });

  test("does not rewrite a path already under the passthrough prefix", async () => {
    const { url } = await forwardedUpstream(
      "/v1/oauth/proxy/google/gmail/v1/users/me/drafts",
      {
        method: "GET",
        headers: { authorization: `Bearer ${mintGoogleProxyGrant()}` },
      },
    );

    expect(url).toBe(
      "http://localhost:7821/v1/oauth/proxy/google/gmail/v1/users/me/drafts",
    );
  });

  test("does not retarget a grant at a different provider's already-prefixed path", async () => {
    const { url } = await forwardedUpstream(
      "/v1/oauth/proxy/stripe_link/v1/charges",
      {
        method: "GET",
        headers: { authorization: `Bearer ${mintGoogleProxyGrant()}` },
      },
    );

    expect(url).toBe(
      "http://localhost:7821/v1/oauth/proxy/stripe_link/v1/charges",
    );
  });

  test("does not rewrite a host-absolute path without a proxy grant", async () => {
    const { url } = await forwardedUpstream(
      "/upload/gmail/v1/users/me/drafts?uploadType=media",
      {},
    );

    expect(url).toBe(
      "http://localhost:7821/upload/gmail/v1/users/me/drafts?uploadType=media",
    );
  });
});
