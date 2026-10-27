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
  spyOn,
  test,
} from "bun:test";
import type * as LocalMode from "@/lib/local-mode";
import type * as CaptureError from "@/lib/error-reporting/capture-error";

const isLocalClientMock = mock(() => false);
const isCadetCloudRemoteMock = mock(() => false);
const servedGatewayRuntimeFromConfig = (): boolean => {
  const remote = readInjectedConfig()?.remote;
  return remote === "docker" || remote === "custom";
};
const isServedGatewayRuntimeMock = mock(servedGatewayRuntimeFromConfig);
mock.module(
  "@/lib/local-mode",
  (): Partial<typeof LocalMode> => ({
    getLocalAssistants: () => [],
    hasLocalGateway: () => false,
    getServedLockfile: () => ({ assistants: [], activeAssistant: null }),
    getCloudAssistants: () => [],
    getActiveAssistant: () => undefined,
    hasAssistants: () => false,
    isLocalAssistant: () => false,
    isLocalClient: isLocalClientMock,
    isCloudAssistant: () => false,
    isCadetCloudRemote: isCadetCloudRemoteMock,
    isServedGatewayRuntime: isServedGatewayRuntimeMock,
    primeLocalGatewayConnection: async () => {},
    retireLocalAssistant: async () => ({ ok: false }),
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
  platformFeaturesGate,
  requestInterceptor,
  rewriteForSelfHostedIngress,
} from "@/lib/api-interceptors";

import { ApiError } from "@/utils/api-errors";
import { setSelfHostedConnection } from "@/lib/self-hosted/connection";
import { getClientId } from "@/lib/client-identity";
import { __resetForTesting as resetSessionToken } from "@/runtime/session-token";
import { readInjectedConfig } from "@/lib/injected-config";

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
const INGRESS = "https://my-gateway.example";
const ACTOR_TOKEN = "test-actor-token-abc123";
const RUNTIME_PROXIED_PATH = `/v1/assistants/${SELF_HOSTED_ID}/conversations/`;

describe("api-interceptors / self-hosted rewriting", () => {
  beforeAll(() => {
    setCsrfCookie("test-csrf-token");
  });

  afterAll(() => {
    clearCsrfCookie();
  });

  afterEach(() => {
    setSelfHostedConnection(null);
  });

  test("rewrites the URL origin to the configured ingress", async () => {
    setSelfHostedConnection({ url: INGRESS, token: ACTOR_TOKEN });
    const input = new Request(
      `https://platform.test${RUNTIME_PROXIED_PATH}?limit=50`,
    );
    const output = await requestInterceptor(input);
    const outUrl = new URL(output.url);
    expect(outUrl.origin).toBe(INGRESS);
    expect(outUrl.pathname).toBe(RUNTIME_PROXIED_PATH);
    expect(outUrl.search).toBe("?limit=50");
  });

  test("rewrites the live events SSE stream to the ingress", async () => {
    // The events stream opens through the cloud client; in local /
    // self-hosted mode it must route to the gateway like conversations
    // rather than fall through to the cloud proxy.
    setSelfHostedConnection({ url: INGRESS, token: ACTOR_TOKEN });
    const eventsPath = `/v1/assistants/${SELF_HOSTED_ID}/events/`;
    const input = new Request(
      `https://platform.test${eventsPath}?lastSeenSeq=42`,
    );
    const output = await requestInterceptor(input);
    const outUrl = new URL(output.url);
    expect(outUrl.origin).toBe(INGRESS);
    expect(outUrl.pathname).toBe(eventsPath);
    expect(outUrl.search).toBe("?lastSeenSeq=42");
    expect(output.headers.get("Authorization")).toBe(`Bearer ${ACTOR_TOKEN}`);
  });

  test("rewrites user-defined route handler (`/x/`) calls to the ingress", async () => {
    // Sandboxed apps POST to their backend handlers under `/v1/x/*`
    // through the cloud client; in local / self-hosted mode these
    // must route to the gateway rather than fall through to the
    // cloud proxy.
    setSelfHostedConnection({ url: INGRESS, token: ACTOR_TOKEN });
    const userRoutePath = `/v1/assistants/${SELF_HOSTED_ID}/x/us-vs-the-world`;
    const input = new Request(`https://platform.test${userRoutePath}`, {
      method: "POST",
    });
    const output = await requestInterceptor(input);
    const outUrl = new URL(output.url);
    expect(outUrl.origin).toBe(INGRESS);
    expect(outUrl.pathname).toBe(userRoutePath);
    expect(output.headers.get("Authorization")).toBe(`Bearer ${ACTOR_TOKEN}`);
  });

  test("rewrites daemon/gateway-owned segments reached via the cloud client", async () => {
    // config is daemon-owned and still called through the cloud client
    // via raw `client.*` requests (the background `TimezoneSync` PATCH).
    // In local / self-hosted mode it must route to the gateway like
    // conversations rather than fall through to the dead cloud proxy
    // and flood the console with 502s. (artifacts is NOT listed — its
    // assistant-scoped routes aren't served by the gateway or daemon, so
    // forwarding it would only 404.)
    setSelfHostedConnection({ url: INGRESS, token: ACTOR_TOKEN });
    for (const segment of ["config"]) {
      const path = `/v1/assistants/${SELF_HOSTED_ID}/${segment}/`;
      const input = new Request(`https://platform.test${path}`, {
        method: "POST",
      });
      const output = await requestInterceptor(input);
      const outUrl = new URL(output.url);
      expect(outUrl.origin).toBe(INGRESS);
      expect(outUrl.pathname).toBe(path);
      expect(output.headers.get("Authorization")).toBe(`Bearer ${ACTOR_TOKEN}`);
    }
  });

  test("prepends the ingress path prefix when the ingress URL has a path", async () => {
    const prefixedIngress = "http://localhost:3000/web/20100";
    setSelfHostedConnection({ url: prefixedIngress, token: ACTOR_TOKEN });
    const input = new Request(
      `https://platform.test/v1/assistants/self/conversations`,
    );
    const output = await requestInterceptor(input);
    const outUrl = new URL(output.url);
    expect(outUrl.origin).toBe("http://localhost:3000");
    expect(outUrl.pathname).toBe("/web/20100/v1/assistants/self/conversations");
  });

  test("strips platform-only headers from the rewritten request", async () => {
    setSelfHostedConnection({ url: INGRESS, token: ACTOR_TOKEN });
    const input = new Request(`https://platform.test${RUNTIME_PROXIED_PATH}`, {
      method: "POST",
    });
    const output = await requestInterceptor(input);
    expect(output.headers.get("X-CSRFToken")).toBeNull();
  });

  test("attaches Authorization: Bearer <token> when the actor token is set", async () => {
    setSelfHostedConnection({ url: INGRESS, token: ACTOR_TOKEN });
    const input = new Request(`https://platform.test${RUNTIME_PROXIED_PATH}`);
    const output = await requestInterceptor(input);
    expect(output.headers.get("Authorization")).toBe(`Bearer ${ACTOR_TOKEN}`);
  });

  test("omits the Authorization header when the actor token slot is null", async () => {
    // Brief post-hatch window: `is_local=true` and `ingress_url` is
    // known but `bootstrap_platform_actor_token` hasn't landed yet.
    // The interceptor leaves Authorization off; the gateway 401s; the
    // chat surface lands on its error state. Don't fall back to
    // platform session credentials here — that would silently route
    // a self-hosted request through the wrong trust boundary.
    setSelfHostedConnection({ url: INGRESS, token: null });
    const input = new Request(`https://platform.test${RUNTIME_PROXIED_PATH}`);
    const output = await requestInterceptor(input);
    expect(output.headers.get("Authorization")).toBeNull();
  });

  test("preserves client + interface identity headers across the rewrite", async () => {
    setSelfHostedConnection({ url: INGRESS, token: ACTOR_TOKEN });
    const input = new Request(`https://platform.test${RUNTIME_PROXIED_PATH}`);
    const output = await requestInterceptor(input);
    expect(output.headers.get("X-Cadet-Client-Id")).toBe(getClientId());
    expect(output.headers.get("X-Cadet-Interface-Id")).toBe("web");
  });

  test("rewrites assistant event routes to the self-hosted gateway", async () => {
    setSelfHostedConnection({ url: INGRESS, token: ACTOR_TOKEN });
    const input = new Request(
      "https://platform.test/v1/assistants/self/events/",
    );
    const output = await requestInterceptor(input);
    expect(new URL(output.url).origin).toBe(INGRESS);
    expect(output.headers.get("Authorization")).toBe(`Bearer ${ACTOR_TOKEN}`);
    expect(output.headers.get("X-CSRFToken")).toBeNull();
  });

  test("omits cookie credentials on the rewritten request", async () => {
    setSelfHostedConnection({ url: INGRESS, token: ACTOR_TOKEN });
    const input = new Request(`https://platform.test${RUNTIME_PROXIED_PATH}`);
    const output = await requestInterceptor(input);
    expect(output.credentials).toBe("omit");
  });

  test("does NOT rewrite when no connection is set", async () => {
    const input = new Request(`https://platform.test${RUNTIME_PROXIED_PATH}`);
    const output = await requestInterceptor(input);
    expect(new URL(output.url).origin).toBe("https://platform.test");
    expect(output.headers.get("Authorization")).toBeNull();
  });

  test("does NOT rewrite when ingress url is null even if token is set", async () => {
    // Symmetric to the "token-null" window: an assistant can be
    // `is_local=true` with a token already bootstrapped but no public
    // gateway hostname yet. Without an ingress to rewrite to, the
    // request falls through to the cloud proxy view — which 404s,
    // surfacing as the chat error state one HTTP hop sooner.
    setSelfHostedConnection({ url: null, token: ACTOR_TOKEN });
    const input = new Request(`https://platform.test${RUNTIME_PROXIED_PATH}`);
    const output = await requestInterceptor(input);
    expect(new URL(output.url).origin).toBe("https://platform.test");
    expect(output.headers.get("Authorization")).toBeNull();
  });

  test("does NOT rewrite first segments outside the allowlist", async () => {
    // The cloud client's narrow allowlist ensures platform-owned routes
    // (and runtime routes not yet mirrored on the gateway) fall through
    // rather than being rewritten. Pin the non-rewriting contract for the
    // routes most likely to get mistakenly captured.
    setSelfHostedConnection({ url: INGRESS, token: ACTOR_TOKEN });
    for (const segment of [
      "activate",
      "resize",
      "restart",
      "retire",
      "backups",
      "system-events",
      "terminal",
      "doctor",
      "domains",
      "email-addresses",
      "oauth",
      // `/a2a/invites/redeem` is a cloud broker route.
      "a2a",
      // Device and Live Activity token registration is cloud-owned. Cloud
      // and local-with-ingress keep the session path; remote-gateway
      // authorizes these separately rather than rewriting them here.
      "push-tokens",
      "live-activity",
      // artifacts is daemon/gateway-owned but no gateway or daemon route
      // serves it, so it must NOT be rewritten — forwarding would 404
      // rather than reach a handler.
      "artifacts",
    ]) {
      const input = new Request(
        `https://platform.test/v1/assistants/${SELF_HOSTED_ID}/${segment}/`,
        { method: "POST" },
      );
      const output = await requestInterceptor(input);
      expect(new URL(output.url).origin).toBe("https://platform.test");
      // Platform path keeps stamping CSRF as before.
      expect(output.headers.get("X-CSRFToken")).toBe("test-csrf-token");
      // And never leaks the gateway token onto a cloud-bound
      // request, even when the connection slot is populated.
      expect(output.headers.get("Authorization")).toBeNull();
    }
  });

  test("does NOT rewrite the bare retrieve route", async () => {
    // `/v1/assistants/{id}/` is the canonical retrieve — the assistant
    // record lives on the cloud regardless of where the runtime
    // runs. Routing it to ingress would 404.
    setSelfHostedConnection({ url: INGRESS, token: ACTOR_TOKEN });
    const input = new Request(
      `https://platform.test/v1/assistants/${SELF_HOSTED_ID}/`,
    );
    const output = await requestInterceptor(input);
    expect(new URL(output.url).origin).toBe("https://platform.test");
    expect(output.headers.get("Authorization")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Self-hosted rewriting — daemon client (daemonRequestInterceptor)
// ---------------------------------------------------------------------------
//
// The daemon client bypasses the segment allowlist entirely. Every
// daemon SDK request is a daemon route by definition, so all assistant
// sub-resource paths are forwarded to the self-hosted gateway.
//
// This means daemon SDK calls for skills, plugins, memories, etc. are
// correctly routed even though they're not in RUNTIME_PROXIED_FIRST_SEGMENTS.

const DAEMON_SKILLS_PATH = `/v1/assistants/${SELF_HOSTED_ID}/skills/`;
const DAEMON_PLUGINS_PATH = `/v1/assistants/${SELF_HOSTED_ID}/plugins/`;
const DAEMON_MEMORY_PATH = `/v1/assistants/${SELF_HOSTED_ID}/memory-items/`;

describe("api-interceptors / daemon client self-hosted rewriting", () => {
  beforeAll(() => {
    setCsrfCookie("test-csrf-token");
  });

  afterAll(() => {
    clearCsrfCookie();
  });

  afterEach(() => {
    setSelfHostedConnection(null);
  });

  test("rewrites daemon paths that are NOT in the cloud allowlist", async () => {
    setSelfHostedConnection({ url: INGRESS, token: ACTOR_TOKEN });
    for (const path of [
      DAEMON_SKILLS_PATH,
      DAEMON_PLUGINS_PATH,
      DAEMON_MEMORY_PATH,
    ]) {
      const input = new Request(`https://platform.test${path}`);
      const output = await daemonRequestInterceptor(input);
      const outUrl = new URL(output.url);
      expect(outUrl.origin).toBe(INGRESS);
      expect(outUrl.pathname).toBe(path);
      expect(output.headers.get("Authorization")).toBe(`Bearer ${ACTOR_TOKEN}`);
      expect(output.headers.get("X-CSRFToken")).toBeNull();
    }
  });

  test("rewrites allowlisted paths too (conversations)", async () => {
    setSelfHostedConnection({ url: INGRESS, token: ACTOR_TOKEN });
    const input = new Request(`https://platform.test${RUNTIME_PROXIED_PATH}`);
    const output = await daemonRequestInterceptor(input);
    expect(new URL(output.url).origin).toBe(INGRESS);
  });

  test("falls through to platform dressing when no connection is set", async () => {
    const input = new Request(`https://platform.test${DAEMON_SKILLS_PATH}`, {
      method: "POST",
    });
    const output = await daemonRequestInterceptor(input);
    expect(new URL(output.url).origin).toBe("https://platform.test");
    expect(output.headers.get("X-CSRFToken")).toBe("test-csrf-token");
  });

  test("does NOT rewrite the bare retrieve route", async () => {
    setSelfHostedConnection({ url: INGRESS, token: ACTOR_TOKEN });
    const input = new Request(
      `https://platform.test/v1/assistants/${SELF_HOSTED_ID}/`,
    );
    const output = await daemonRequestInterceptor(input);
    // Bare retrieve has no sub-resource segment — regex doesn't match.
    expect(new URL(output.url).origin).toBe("https://platform.test");
  });

  test("preserves client + interface identity headers", async () => {
    setSelfHostedConnection({ url: INGRESS, token: ACTOR_TOKEN });
    const input = new Request(`https://platform.test${DAEMON_SKILLS_PATH}`);
    const output = await daemonRequestInterceptor(input);
    expect(output.headers.get("X-Cadet-Client-Id")).toBe(getClientId());
    expect(output.headers.get("X-Cadet-Interface-Id")).toBe("web");
  });
});

// ---------------------------------------------------------------------------
// Self-hosted contact-family flattening
// ---------------------------------------------------------------------------
//
// Contact-family paths (`contacts`, `contact-channels`) are forwarded to
// the ingress prefix-stripped — `/v1/assistants/{id}/<rest>` becomes
// `/v1/<rest>` — matching what cloud's runtime proxy delivers
// to the gateway, which serves the family on its flat control-plane
// routes. Both interceptor entry points (platform client and daemon
// client) converge on the same flat path; every other segment keeps
// today's verbatim scoped forwarding.

const CONTACT_FLATTEN_CASES = [
  { method: "POST", scoped: "contacts", flat: "/v1/contacts" },
  {
    method: "DELETE",
    scoped: "contacts/contact-123",
    flat: "/v1/contacts/contact-123",
  },
  {
    method: "POST",
    scoped: "contacts/prompt/submit",
    flat: "/v1/contacts/prompt/submit",
  },
  { method: "POST", scoped: "contacts/merge", flat: "/v1/contacts/merge" },
  {
    method: "GET",
    scoped: "contacts/invites",
    flat: "/v1/contacts/invites",
  },
  {
    method: "DELETE",
    scoped: "contacts/invites/invite-456",
    flat: "/v1/contacts/invites/invite-456",
  },
  {
    method: "POST",
    scoped: "contact-channels/channel-abc/verify",
    flat: "/v1/contact-channels/channel-abc/verify",
  },
  {
    method: "PATCH",
    scoped: "contact-channels/channel-abc",
    flat: "/v1/contact-channels/channel-abc",
  },
] as const;

describe("api-interceptors / self-hosted contact-family flattening", () => {
  beforeAll(() => {
    setCsrfCookie("test-csrf-token");
  });

  afterAll(() => {
    clearCsrfCookie();
  });

  afterEach(() => {
    setSelfHostedConnection(null);
  });

  const ENTRY_POINTS = [
    ["platform client", requestInterceptor],
    ["daemon client", daemonRequestInterceptor],
  ] as const;

  for (const [label, interceptor] of ENTRY_POINTS) {
    test(`${label}: strips the assistant prefix from contact-family paths`, async () => {
      setSelfHostedConnection({ url: INGRESS, token: ACTOR_TOKEN });
      for (const { method, scoped, flat } of CONTACT_FLATTEN_CASES) {
        const input = new Request(
          `https://platform.test/v1/assistants/${SELF_HOSTED_ID}/${scoped}`,
          { method },
        );
        const output = await interceptor(input);
        const outUrl = new URL(output.url);
        expect(outUrl.origin).toBe(INGRESS);
        expect(outUrl.pathname).toBe(flat);
        expect(output.headers.get("Authorization")).toBe(
          `Bearer ${ACTOR_TOKEN}`,
        );
        expect(output.headers.get("X-CSRFToken")).toBeNull();
      }
    });

    test(`${label}: preserves the query string on flattened list requests`, async () => {
      setSelfHostedConnection({ url: INGRESS, token: ACTOR_TOKEN });
      const input = new Request(
        `https://platform.test/v1/assistants/${SELF_HOSTED_ID}/contacts?query=x`,
      );
      const output = await interceptor(input);
      const outUrl = new URL(output.url);
      expect(outUrl.origin).toBe(INGRESS);
      expect(outUrl.pathname).toBe("/v1/contacts");
      expect(outUrl.search).toBe("?query=x");
    });
  }

  test("prepends the ingress path prefix to flattened paths", async () => {
    setSelfHostedConnection({
      url: "http://localhost:3000/web/20100",
      token: ACTOR_TOKEN,
    });
    const input = new Request(
      `https://platform.test/v1/assistants/${SELF_HOSTED_ID}/contacts`,
      { method: "POST" },
    );
    const output = await daemonRequestInterceptor(input);
    const outUrl = new URL(output.url);
    expect(outUrl.origin).toBe("http://localhost:3000");
    expect(outUrl.pathname).toBe("/web/20100/v1/contacts");
  });

  test("non-contact segments keep the scoped path", async () => {
    setSelfHostedConnection({ url: INGRESS, token: ACTOR_TOKEN });
    for (const [interceptor, segment] of [
      [requestInterceptor, "conversations"],
      [requestInterceptor, "config"],
      [daemonRequestInterceptor, "skills"],
    ] as const) {
      const path = `/v1/assistants/${SELF_HOSTED_ID}/${segment}/`;
      const input = new Request(`https://platform.test${path}`);
      const output = await interceptor(input);
      const outUrl = new URL(output.url);
      expect(outUrl.origin).toBe(INGRESS);
      expect(outUrl.pathname).toBe(path);
    }
  });

  test("keepalive survives the rewrite, so a pagehide-time send is not cancelled", async () => {
    setSelfHostedConnection({ url: INGRESS, token: ACTOR_TOKEN });
    // Bun's Request neither stores nor re-exposes `keepalive`, so the flag is
    // stamped onto the input and the assertion intercepts the init the
    // rewrite hands the constructor, instead of reading the property back.
    const input = new Request(
      `https://platform.test/v1/assistants/${SELF_HOSTED_ID}/telemetry/ingest`,
      { method: "POST", body: "{}" },
    );
    Object.defineProperty(input, "keepalive", { value: true });

    const OriginalRequest = globalThis.Request;
    let rebuiltInit: RequestInit | undefined;
    globalThis.Request = class extends OriginalRequest {
      constructor(info: RequestInfo | URL, init?: RequestInit) {
        super(info, init);
        rebuiltInit = init;
      }
    } as typeof Request;
    try {
      const output = await rewriteForSelfHostedIngress(input, {
        skipSegmentAllowlist: true,
      });
      expect(output).not.toBeNull();
      expect(rebuiltInit?.keepalive).toBe(true);
    } finally {
      globalThis.Request = OriginalRequest;
    }
  });

  test("no ingress registered — rewrite returns null and the request is untouched", async () => {
    const scopedPath = `/v1/assistants/${SELF_HOSTED_ID}/contacts`;
    const input = new Request(`https://platform.test${scopedPath}`, {
      method: "POST",
    });
    expect(await rewriteForSelfHostedIngress(input)).toBeNull();
    expect(
      await rewriteForSelfHostedIngress(input, { skipSegmentAllowlist: true }),
    ).toBeNull();

    const output = await requestInterceptor(input);
    const outUrl = new URL(output.url);
    expect(outUrl.origin).toBe("https://platform.test");
    expect(outUrl.pathname).toBe(scopedPath);
  });
});

// ---------------------------------------------------------------------------
// Remote gateway direct requests
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
    setSelfHostedConnection(null);
    clearCsrfCookie();
  });

  test("authorizes daemon same-origin flat /v1 requests with the paired browser token", async () => {
    setSelfHostedConnection({
      url: window.location.origin,
      token: ACTOR_TOKEN,
    });
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
    setSelfHostedConnection({
      url: window.location.origin,
      token: ACTOR_TOKEN,
    });
    const input = new Request(
      `${window.location.origin}/v1/assistants/self/messages?conversationId=conv-1`,
    );

    const output = await daemonRequestInterceptor(input);

    expect(output.url).toBe(input.url);
    expect(output.headers.get("Authorization")).toBe(`Bearer ${ACTOR_TOKEN}`);
    expect(output.headers.get("ngrok-skip-browser-warning")).toBe("true");
  });

  test("preserves a remote ingress path prefix for flat /v1 requests", () => {
    setSelfHostedConnection({
      url: `${window.location.origin}/assistant-123`,
      token: ACTOR_TOKEN,
    });
    const input = new Request(
      `${window.location.origin}/assistant-123/v1/contacts`,
    );

    const output = authorizeRemoteGatewayRequest(input);

    expect(output?.url).toBe(input.url);
    expect(output?.headers.get("Authorization")).toBe(`Bearer ${ACTOR_TOKEN}`);
  });

  test("does not authorize non-prefixed /v1 requests when the remote ingress is path-prefixed", () => {
    setSelfHostedConnection({
      url: `${window.location.origin}/assistant-123`,
      token: ACTOR_TOKEN,
    });
    const input = new Request(`${window.location.origin}/v1/contacts`);

    expect(authorizeRemoteGatewayRequest(input)).toBeNull();
  });

  test("authorizes cloud-client push-token upserts with the paired browser token", async () => {
    setSelfHostedConnection({
      url: window.location.origin,
      token: ACTOR_TOKEN,
    });
    const path = `/v1/assistants/${SELF_HOSTED_ID}/push-tokens/`;
    const input = new Request(`${window.location.origin}${path}`, {
      method: "POST",
    });

    const output = await requestInterceptor(input);

    expect(output.url).toBe(input.url);
    expect(output.credentials).toBe("omit");
    expect(output.headers.get("Authorization")).toBe(`Bearer ${ACTOR_TOKEN}`);
    expect(output.headers.get("X-CSRFToken")).toBeNull();
    expect(platformFeaturesGate(output).signal.aborted).toBe(false);
  });

  test("authorizes cloud-client live-activity upserts with the paired browser token", async () => {
    setSelfHostedConnection({
      url: window.location.origin,
      token: ACTOR_TOKEN,
    });
    const path = `/v1/assistants/${SELF_HOSTED_ID}/live-activity/tokens/`;
    const input = new Request(`${window.location.origin}${path}`, {
      method: "POST",
    });

    const output = await requestInterceptor(input);

    expect(output.headers.get("Authorization")).toBe(`Bearer ${ACTOR_TOKEN}`);
    expect(platformFeaturesGate(output).signal.aborted).toBe(false);
  });

  test("preserves a remote ingress path prefix for cloud-client push-token upserts", async () => {
    setSelfHostedConnection({
      url: `${window.location.origin}/assistant-123`,
      token: ACTOR_TOKEN,
    });
    const path = `/assistant-123/v1/assistants/${SELF_HOSTED_ID}/push-tokens/`;
    const input = new Request(`${window.location.origin}${path}`, {
      method: "POST",
    });

    const output = await requestInterceptor(input);

    expect(output.url).toBe(input.url);
    expect(output.headers.get("Authorization")).toBe(`Bearer ${ACTOR_TOKEN}`);
    expect(platformFeaturesGate(output).signal.aborted).toBe(false);
  });

  test("relocates an origin-root push-token upsert under a path-prefixed remote ingress", async () => {
    setSelfHostedConnection({
      url: `${window.location.origin}/assistant-123`,
      token: ACTOR_TOKEN,
    });
    const input = new Request(
      `${window.location.origin}/v1/assistants/${SELF_HOSTED_ID}/push-tokens/`,
      { method: "POST" },
    );

    const output = await requestInterceptor(input);

    expect(new URL(output.url).pathname).toBe(
      `/assistant-123/v1/assistants/${SELF_HOSTED_ID}/push-tokens/`,
    );
    expect(output.headers.get("Authorization")).toBe(`Bearer ${ACTOR_TOKEN}`);
    expect(platformFeaturesGate(output).signal.aborted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Platform features gate
// ---------------------------------------------------------------------------
//
// In local mode with platform features disabled, the abort interceptor
// must NOT kill requests already rewritten to the self-hosted gateway.
//
// The test setup stamps remote "cloud" (platform mode).
// These tests flip the isLocalClient mock so it returns true.

describe("api-interceptors / platform features gate", () => {
  beforeAll(() => {
    isLocalClientMock.mockImplementation(() => true);
  });

  afterAll(() => {
    isLocalClientMock.mockImplementation(() => false);
  });

  afterEach(() => {
    window.__CADET_CONFIG__ = undefined;
    setSelfHostedConnection(null);
  });

  test("aborts platform requests in remote-gateway mode", () => {
    window.__CADET_CONFIG__ = { remote: "docker" };
    const input = new Request(
      `${window.location.origin}/v1/contacts/client-flag-values/`,
    );
    const output = platformFeaturesGate(input);
    expect(output.signal.aborted).toBe(true);
    expect((output.signal.reason as DOMException).message).toBe(
      "Platform routes disabled in remote-gateway mode",
    );
  });

  test("passes bearer-authenticated gateway requests in remote-gateway mode", () => {
    window.__CADET_CONFIG__ = { remote: "docker" };
    const input = new Request(
      `${window.location.origin}/v1/assistants/self/events/`,
      { headers: { Authorization: `Bearer ${ACTOR_TOKEN}` } },
    );
    const output = platformFeaturesGate(input);
    expect(output.signal.aborted).toBe(false);
    expect(output.url).toBe(input.url);
  });
});

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

describe("api-interceptors / local-mode body buffering", () => {
  beforeAll(() => {
    isLocalClientMock.mockImplementation(() => true);
  });

  afterAll(() => {
    isLocalClientMock.mockImplementation(() => false);
  });

  afterEach(() => {
    setSelfHostedConnection(null);
  });

  test("buffers the request body via .blob()", async () => {
    // .blob() yields a by-reference body; reverting to .arrayBuffer() (which
    // never calls .blob()) would fail this and reintroduce the >1.5 MB stall.
    setSelfHostedConnection({ url: INGRESS, token: ACTOR_TOKEN });
    const blobSpy = spyOn(Request.prototype, "blob");
    try {
      const input = new Request(
        `https://platform.test${RUNTIME_PROXIED_PATH}`,
        {
          method: "POST",
          body: "upload-payload",
        },
      );
      await daemonRequestInterceptor(input);
      expect(blobSpy).toHaveBeenCalled();
    } finally {
      blobSpy.mockRestore();
    }
  });

  test("the rewritten request carries the buffered body content", async () => {
    setSelfHostedConnection({ url: INGRESS, token: ACTOR_TOKEN });
    const input = new Request(`https://platform.test${RUNTIME_PROXIED_PATH}`, {
      method: "POST",
      body: "upload-payload",
    });
    const output = await daemonRequestInterceptor(input);
    expect(new URL(output.url).origin).toBe(INGRESS);
    expect(await output.text()).toBe("upload-payload");
  });

  test("a bodyless GET is rewritten without buffering", async () => {
    setSelfHostedConnection({ url: INGRESS, token: ACTOR_TOKEN });
    const blobSpy = spyOn(Request.prototype, "blob");
    try {
      const input = new Request(`https://platform.test${RUNTIME_PROXIED_PATH}`);
      const output = await daemonRequestInterceptor(input);
      expect(new URL(output.url).origin).toBe(INGRESS);
      expect(blobSpy).not.toHaveBeenCalled();
    } finally {
      blobSpy.mockRestore();
    }
  });
});
