/**
 * Unit tests for the HeyAPI client request interceptor.
 *
 * Pins the ATL-703 header contract: every outbound request — regardless of
 * method — must carry `X-Cadet-Client-Id` + `X-Cadet-Interface-Id` so the
 * daemon can echo the originator id back on `sync_changed` and the hub can
 * suppress the SSE echo to that subscriber.
 *
 * The test calls `requestInterceptor` directly instead of round-tripping
 * through the HeyAPI client. That way we don't depend on any private
 * interceptor-list internals; if the interceptor function gets the inputs
 * right, the registrations at the bottom of the module do the rest.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import type * as LocalMode from "@/lib/local-mode";
import type * as CaptureError from "@/lib/error-reporting/capture-error";

const isCadetCloudRemoteMock = mock(() => false);
mock.module(
  "@/lib/local-mode",
  (): Partial<typeof LocalMode> => ({
    isCadetCloudRemote: isCadetCloudRemoteMock,
  }),
);

// Error reporting, stubbed so a failed in-place recovery doesn't touch the
// real client. The failure evidence lives on the durable lifecycle ring.
const captureErrorMock = mock((_err: unknown, _ctx?: unknown) => {});
mock.module(
  "@/lib/error-reporting/capture-error",
  (): Partial<typeof CaptureError> => ({
    captureError: captureErrorMock,
  }),
);

const lifecycleDiagnosticCalls: Array<[string, Record<string, unknown>]> = [];
mock.module("@/lib/diagnostics", () => ({
  recordLifecycleDiagnostic: (
    kind: string,
    details: Record<string, unknown> = {},
  ) => {
    lifecycleDiagnosticCalls.push([kind, details]);
  },
}));

import {
  authorizeRemoteGatewayRequest,
  daemonErrorInterceptor,
  daemonRequestInterceptor,
  requestInterceptor,
} from "@/lib/api-interceptors";

import { ApiError } from "@/utils/api-errors";
import { getClientId } from "@/lib/client-identity";
import { __resetForTesting as resetSessionToken } from "@/runtime/session-token";

const ELECTRON_RENDERER_ORIGIN_HEADER = "X-Cadet-Electron-Renderer-Origin";

function setCsrfCookie(token: string): void {
  document.cookie = `csrftoken=${token}; path=/`;
}

function clearCsrfCookie(): void {
  document.cookie = "csrftoken=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
}

async function intercept(
  method: string,
  url = "https://example.test/v1/probe",
) {
  const request = new Request(url, { method });
  const result = await requestInterceptor(request);
  return result.headers;
}

describe("api-interceptors / requestInterceptor", () => {
  beforeAll(() => {
    setCsrfCookie("test-csrf-token");
  });

  afterAll(() => {
    clearCsrfCookie();
  });

  test("attaches X-Cadet-Client-Id and X-Cadet-Interface-Id on GET", async () => {
    const headers = await intercept("GET");
    expect(headers.get("X-Cadet-Client-Id")).toBe(getClientId());
    expect(headers.get("X-Cadet-Interface-Id")).toBe("web");
    expect(headers.get("Accept-Language")).toBe("en");
  });

  test("attaches X-Cadet-Client-Id and X-Cadet-Interface-Id on POST", async () => {
    const headers = await intercept("POST");
    expect(headers.get("X-Cadet-Client-Id")).toBe(getClientId());
    expect(headers.get("X-Cadet-Interface-Id")).toBe("web");
  });

  test("attaches client + interface headers on PUT, PATCH, DELETE", async () => {
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const headers = await intercept(method);
      expect(headers.get("X-Cadet-Client-Id")).toBe(getClientId());
      expect(headers.get("X-Cadet-Interface-Id")).toBe("web");
    }
  });

  test("attaches X-CSRFToken on mutating requests", async () => {
    const headers = await intercept("POST");
    expect(headers.get("X-CSRFToken")).toBe("test-csrf-token");
  });

  test("does not attach X-CSRFToken on safe requests", async () => {
    const headers = await intercept("GET");
    expect(headers.get("X-CSRFToken")).toBeNull();
  });

  test("does not attach the session-token header on web (no Electron bridge)", async () => {
    const headers = await intercept("GET");
    expect(headers.get("X-Session-Token")).toBeNull();
  });

  test("does not attach renderer-origin marker outside Electron", async () => {
    const headers = await intercept("POST");
    expect(headers.get(ELECTRON_RENDERER_ORIGIN_HEADER)).toBeNull();
  });

  test("returns a new Request, leaving the input headers untouched", async () => {
    const input = new Request("https://example.test/v1/probe", {
      method: "POST",
    });
    expect(input.headers.get("X-Cadet-Client-Id")).toBeNull();

    const output = await requestInterceptor(input);
    expect(output).not.toBe(input);
    expect(input.headers.get("X-Cadet-Client-Id")).toBeNull();
    expect(output.headers.get("X-Cadet-Client-Id")).toBe(getClientId());
  });
});

describe("api-interceptors / Electron session-token header", () => {
  beforeAll(() => {
    setCsrfCookie("test-csrf-token");
  });

  beforeEach(() => {
    (window as unknown as { cadet?: unknown }).cadet = {
      platform: "electron",
      auth: { getSessionToken: () => "electron-sess-tok" },
    };
  });

  afterEach(() => {
    delete (window as unknown as { cadet?: unknown }).cadet;
    resetSessionToken();
  });

  afterAll(() => {
    clearCsrfCookie();
  });

  test("attaches the session-token header on platform requests", async () => {
    const headers = await intercept("GET");
    expect(headers.get("X-Session-Token")).toBe("electron-sess-tok");
  });

  test("drops CSRF on mutations — header auth, not cookie auth", async () => {
    const headers = await intercept("POST");
    expect(headers.get("X-Session-Token")).toBe("electron-sess-tok");
    expect(headers.get("X-CSRFToken")).toBeNull();
  });

  test("attaches renderer-origin marker on Electron mutating requests", async () => {
    const headers = await intercept("POST");
    expect(headers.get(ELECTRON_RENDERER_ORIGIN_HEADER)).toBe(
      `${window.location.protocol}//${window.location.host}`,
    );
  });

  test("does not attach renderer-origin marker on Electron safe requests", async () => {
    const headers = await intercept("GET");
    expect(headers.get(ELECTRON_RENDERER_ORIGIN_HEADER)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Self-hosted rewriting — platform client (requestInterceptor)
// ---------------------------------------------------------------------------
//
// When the assistant resolves to `{ kind: "self_hosted" }`, the lifecycle
// hook calls `setSelfHostedConnection({ url, token })`. From that point
// on, allowlisted runtime-proxied `/v1/assistants/{id}/<segment>/...`
// calls leave the cloud's base URL behind and go directly to the
// user's gateway.
//
// The cloud client uses the segment allowlist — only explicitly
// listed segments are rewritten. Platform-owned routes like
// `system-events/`, `terminal/`,
// `doctor/` fall through to the cloud.
//
// These tests pin the invariants that make that handoff safe:
//   - URL origin gets swapped to the registered ingress.
//   - Platform-only headers (X-CSRFToken) are
//     stripped so the user's gateway never sees our session/CSRF state.
//   - `Authorization: Bearer <token>` is attached when the connection
//     has a token, and omitted when the token slot is `null` (the
//     gateway then 401s, and the chat surface lands on its error UI —
//     this is the deliberate behaviour during the brief post-hatch
//     window where `bootstrap_platform_actor_token` hasn't landed yet).
//   - Client/interface identity headers ride along so the gateway can
//     still echo them back for self-echo suppression once SSE lands.
//
// Negative tests confirm we don't route to the gateway when (a) no
// connection is set, (b) the path's first segment isn't on the allowlist
// (`activate`, `system-events`, `terminal`, …), or
// (c) the path is the bare retrieve route `/v1/assistants/{id}/`.

const SELF_HOSTED_ID = "01h1234567890abcdefg";
const ACTOR_TOKEN = "test-actor-token-abc123";

// ---------------------------------------------------------------------------
//
// Remote web serves the SPA from the same nginx edge as the gateway. Daemon and
// gateway generated clients can call flat same-origin `/v1/...` routes directly
// instead of `/v1/assistants/{id}/...`; those need the paired browser token too.

describe("api-interceptors / remote gateway direct requests", () => {
  beforeEach(() => {
    window.__CADET_CONFIG__ = { remote: "docker" };
    setCsrfCookie("test-csrf-token");
  });

  afterEach(() => {
    window.__CADET_CONFIG__ = undefined;
    clearCsrfCookie();
  });

  test("authorizes daemon same-origin flat /v1 requests with the paired browser token", async () => {
    const input = new Request(`${window.location.origin}/v1/contacts`, {});

    const output = await daemonRequestInterceptor(input);

    expect(output.url).toBe(input.url);
    expect(output.credentials).toBe("omit");
    expect(output.headers.get("Authorization")).toBe(`Bearer ${ACTOR_TOKEN}`);
    expect(output.headers.get("X-CSRFToken")).toBeNull();
    expect(output.headers.get("ngrok-skip-browser-warning")).toBe("true");
    expect(output.headers.get("X-Cadet-Client-Id")).toBe(getClientId());
  });

  test("adds the ngrok browser-warning bypass header to rewritten assistant routes", async () => {
    const input = new Request(
      `${window.location.origin}/v1/assistants/self/messages?conversationId=conv-1`,
    );

    const output = await daemonRequestInterceptor(input);

    expect(output.url).toBe(input.url);
    expect(output.headers.get("Authorization")).toBe(`Bearer ${ACTOR_TOKEN}`);
    expect(output.headers.get("ngrok-skip-browser-warning")).toBe("true");
  });

  test("preserves a remote ingress path prefix for flat /v1 requests", () => {
    const input = new Request(
      `${window.location.origin}/assistant-123/v1/contacts`,
    );

    const output = authorizeRemoteGatewayRequest(input);

    expect(output?.url).toBe(input.url);
    expect(output?.headers.get("Authorization")).toBe(`Bearer ${ACTOR_TOKEN}`);
  });

  test("does not authorize non-prefixed /v1 requests when the remote ingress is path-prefixed", () => {
    const input = new Request(`${window.location.origin}/v1/contacts`);

    expect(authorizeRemoteGatewayRequest(input)).toBeNull();
  });

  test("authorizes cloud-client push-token upserts with the paired browser token", async () => {
    const path = `/v1/assistants/${SELF_HOSTED_ID}/push-tokens/`;
    const input = new Request(`${window.location.origin}${path}`, {
      method: "POST",
    });

    const output = await requestInterceptor(input);

    expect(output.url).toBe(input.url);
    expect(output.credentials).toBe("omit");
    expect(output.headers.get("Authorization")).toBe(`Bearer ${ACTOR_TOKEN}`);
    expect(output.headers.get("X-CSRFToken")).toBeNull();
  });

  test("authorizes cloud-client live-activity upserts with the paired browser token", async () => {
    const path = `/v1/assistants/${SELF_HOSTED_ID}/live-activity/tokens/`;
    const input = new Request(`${window.location.origin}${path}`, {
      method: "POST",
    });

    const output = await requestInterceptor(input);

    expect(output.headers.get("Authorization")).toBe(`Bearer ${ACTOR_TOKEN}`);
  });

  test("preserves a remote ingress path prefix for cloud-client push-token upserts", async () => {
    const path = `/assistant-123/v1/assistants/${SELF_HOSTED_ID}/push-tokens/`;
    const input = new Request(`${window.location.origin}${path}`, {
      method: "POST",
    });

    const output = await requestInterceptor(input);

    expect(output.url).toBe(input.url);
    expect(output.headers.get("Authorization")).toBe(`Bearer ${ACTOR_TOKEN}`);
  });

  test("relocates an origin-root push-token upsert under a path-prefixed remote ingress", async () => {
    const input = new Request(
      `${window.location.origin}/v1/assistants/${SELF_HOSTED_ID}/push-tokens/`,
      { method: "POST" },
    );

    const output = await requestInterceptor(input);

    expect(new URL(output.url).pathname).toBe(
      `/assistant-123/v1/assistants/${SELF_HOSTED_ID}/push-tokens/`,
    );
    expect(output.headers.get("Authorization")).toBe(`Bearer ${ACTOR_TOKEN}`);
  });
});

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Daemon error interceptor — ApiError normalization
// ---------------------------------------------------------------------------

describe("api-interceptors / daemonErrorInterceptor", () => {
  const throwing = { throwOnError: true as const };
  const nonThrowing = { throwOnError: false as const };

  test("wraps plain-object errors from non-OK responses into ApiError", () => {
    const body = { detail: "Service unavailable" };
    const response = new Response(null, { status: 503 });
    const result = daemonErrorInterceptor(body, response, undefined, throwing);
    expect(result).toBeInstanceOf(ApiError);
    expect((result as ApiError).status).toBe(503);
    expect((result as ApiError).message).toBe("Service unavailable");
  });

  test("wraps string errors into ApiError", () => {
    const body = "Bad Gateway";
    const response = new Response(null, { status: 502 });
    const result = daemonErrorInterceptor(body, response, undefined, throwing);
    expect(result).toBeInstanceOf(ApiError);
    expect((result as ApiError).status).toBe(502);
    expect((result as ApiError).message).toBe("Bad Gateway");
  });

  test("passes through existing ApiError instances unchanged", () => {
    const existing = new ApiError(401, "Unauthorized");
    const response = new Response(null, { status: 401 });
    const result = daemonErrorInterceptor(
      existing,
      response,
      undefined,
      throwing,
    );
    expect(result).toBe(existing);
  });

  test("passes through errors with no response (network failures)", () => {
    const networkError = new TypeError("fetch failed");
    const result = daemonErrorInterceptor(
      networkError,
      undefined,
      undefined,
      throwing,
    );
    expect(result).toBe(networkError);
  });

  test("passes through errors when response is OK", () => {
    const body = { detail: "unexpected" };
    const response = new Response(null, { status: 200 });
    const result = daemonErrorInterceptor(body, response, undefined, throwing);
    expect(result).toBe(body);
  });

  test("extracts Organization-Id message for 400 errors", () => {
    const body = { detail: "Organization-Id header is required" };
    const response = new Response(null, { status: 400 });
    const result = daemonErrorInterceptor(body, response, undefined, throwing);
    expect(result).toBeInstanceOf(ApiError);
    expect((result as ApiError).status).toBe(400);
    expect((result as ApiError).message).toBe(
      "Organization-Id header is required",
    );
  });

  test("preserves raw error body when throwOnError is false", () => {
    const body = {
      accepted: false,
      error: "secret_blocked",
      message: "Missing API key",
    };
    const response = new Response(null, { status: 422 });
    const result = daemonErrorInterceptor(
      body,
      response,
      undefined,
      nonThrowing,
    );
    expect(result).toBe(body);
    expect(result).not.toBeInstanceOf(ApiError);
  });

  test("preserves raw error body when throwOnError is undefined", () => {
    const body = { detail: "Something went wrong" };
    const response = new Response(null, { status: 500 });
    const result = daemonErrorInterceptor(body, response, undefined, {});
    expect(result).toBe(body);
    expect(result).not.toBeInstanceOf(ApiError);
  });
});

// ---------------------------------------------------------------------------
// Local-mode body buffering — large uploads must not stall
// ---------------------------------------------------------------------------
//
// Over plain HTTP the body can't stream (Chrome refuses a `duplex: "half"`
// body without TLS), so it's buffered. It MUST be buffered to a Blob, not an
// ArrayBuffer: an ArrayBuffer body is streamed to the network process through
// a fixed-capacity (~1-2 MB) data pipe, so a larger upload stalls forever when
// the local consumer (a busy dev server) drains the pipe slowly — the symptom
// being image/file uploads above ~1.5 MB hanging on "Stalled". A Blob is
// passed by reference (blob handle), so there is no renderer-side data pipe to
// block on. The test setup stamps remote "cloud"; these tests flip the
// isLocalClient mock so it returns true and the buffering path runs.
