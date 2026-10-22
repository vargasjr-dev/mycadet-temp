/**
 * Tests for the live-voice WS connection + token-exchange client.
 *
 * Two surfaces under test:
 *   - `mintTunnelWsToken` — must POST `/v1/auth/live-voice-token/` through
 *     the credentialed platform `client` (which attaches session cookie +
 *     CSRF + org header via the interceptor). We spy on `client.post` rather
 *     than `mock.module`-ing the whole SDK, matching the pattern in
 *     `domains/chat/inspector/compaction-trail-fetch.test.ts`.
 *   - `buildTunnelWsUrl` / `buildGatewayWsUrl` and the resolvers on top of
 *     them: the cloud tunnel URL carries the `assistantId` in the path, a
 *     URL-encoded `?token=`, and the `wss` scheme; the self-hosted URL rides
 *     the scoped shape on the ingress origin.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { client } from "@/generated/api/client.gen";
import { setSelfHostedConnection } from "@/lib/self-hosted/connection";

import {
  buildGatewayWsUrl,
  buildTunnelWsUrl,
  getTunnelWsScheme,
  TunnelWsTokenError,
  mintTunnelWsToken,
  resolveGatewayWsUrl,
  resolveLiveVoiceWsUrl,
} from "./connection";

// ---------------------------------------------------------------------------
// mintTunnelWsToken
// ---------------------------------------------------------------------------

type CapturedPostOptions = {
  url: string;
  body?: Record<string, unknown>;
};

let captured: CapturedPostOptions | null = null;
let nextPostResult: { data: unknown; error: unknown; response: Response };
const originalPost = client.post;

beforeEach(() => {
  captured = null;
  nextPostResult = {
    data: { token: "tok-abc", expiresAt: "2026-06-01T00:05:00Z" },
    error: null,
    response: new Response(null, { status: 200 }),
  };
  client.post = mock(async (options: CapturedPostOptions) => {
    captured = options;
    return nextPostResult;
  }) as typeof client.post;
  // Default to the cloud path; self-hosted tests prime this explicitly.
  setSelfHostedConnection(null);
});

afterEach(() => {
  client.post = originalPost;
  setSelfHostedConnection(null);
  window.__CADET_CONFIG__ = undefined;
});

describe("mintTunnelWsToken", () => {
  test("POSTs the documented mint endpoint with the assistantId body", async () => {
    await mintTunnelWsToken("assistant-1");

    expect(captured).not.toBeNull();
    expect(captured!.url).toBe("/v1/auth/live-voice-token/");
    expect(captured!.body).toEqual({ assistantId: "assistant-1" });
  });

  test("returns { token, expiresAt } from the response", async () => {
    const result = await mintTunnelWsToken("assistant-1");
    expect(result).toEqual({
      token: "tok-abc",
      expiresAt: "2026-06-01T00:05:00Z",
    });
  });

  test("throws TunnelWsTokenError with the HTTP status on non-OK", async () => {
    nextPostResult = {
      data: null,
      error: { detail: "forbidden" },
      response: new Response(null, { status: 403 }),
    };

    try {
      await mintTunnelWsToken("assistant-1");
      throw new Error("expected mintTunnelWsToken to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TunnelWsTokenError);
      expect((err as TunnelWsTokenError).status).toBe(403);
    }
  });

  test("throws TunnelWsTokenError(0) when the body is malformed", async () => {
    nextPostResult = {
      data: { token: "tok-abc" }, // missing expiresAt
      error: null,
      response: new Response(null, { status: 200 }),
    };

    try {
      await mintTunnelWsToken("assistant-1");
      throw new Error("expected mintTunnelWsToken to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TunnelWsTokenError);
      expect((err as TunnelWsTokenError).status).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// buildTunnelWsUrl
// ---------------------------------------------------------------------------

describe("buildTunnelWsUrl", () => {
  const args = { assistantId: "assistant-1", routePath: "/v1/live-voice" };

  test("URL-encodes tokens containing reserved characters", () => {
    const token = "a/b+c=d e";
    const raw = buildTunnelWsUrl({ ...args, token });
    // The encoded form must round-trip back to the original token.
    expect(new URL(raw).searchParams.get("token")).toBe(token);
    // And the raw string must not carry the unencoded reserved chars.
    expect(raw).not.toContain("token=a/b+c=d e");
  });

  test("derives the tunnel host from the injected platform URL (Electron shell)", () => {
    window.__CADET_CONFIG__ = {
      cloudUrl: "https://staging-cloud.mycadet.ai",
    };
    const url = new URL(buildTunnelWsUrl({ ...args, token: "tok-abc" }));
    expect(url.protocol).toBe("wss:");
    expect(url.host).toBe("staging-tunnel.mycadet.ai");
  });

  test("falls back to the prod tunnel host for an off-convention platform URL", () => {
    window.__CADET_CONFIG__ = { cloudUrl: "http://localhost:8000" };
    const url = new URL(buildTunnelWsUrl({ ...args, token: "tok-abc" }));
    expect(url.host).toBe("tunnel.mycadet.ai");
  });
});

// ---------------------------------------------------------------------------
// getTunnelWsScheme — TLS for prod, plain ws for the local loopback tunnel
// ---------------------------------------------------------------------------

describe("getTunnelWsScheme", () => {
  test("uses wss for the production tunnel host", () => {
    expect(getTunnelWsScheme("tunnel.mycadet.ai")).toBe("wss");
  });

  test("uses ws for loopback hosts (local vel up tunnel)", () => {
    expect(getTunnelWsScheme("localhost:8501")).toBe("ws");
    expect(getTunnelWsScheme("127.0.0.1:8501")).toBe("ws");
    expect(getTunnelWsScheme("[::1]:8501")).toBe("ws");
  });

  test("uses wss for a non-loopback host without a scheme", () => {
    expect(getTunnelWsScheme("tunnel.staging.mycadet.ai")).toBe("wss");
  });
});

// ---------------------------------------------------------------------------
// buildGatewayWsUrl
// ---------------------------------------------------------------------------
describe("buildGatewayWsUrl", () => {
  const args = {
    assistantId: "asst-1",
    routePath: "/v1/live-voice",
  };

  test("dials the scoped path on the ingress origin, dropping query and hash", () => {
    const url = new URL(
      buildGatewayWsUrl({
        ...args,
        ingressUrl: "https://app.example?a=1#frag",
        params: { conversationId: "conv-xyz" },
      }),
    );
    expect(url.protocol).toBe("wss:");
    expect(url.host).toBe("app.example");
    expect(url.pathname).toBe("/v1/assistants/asst-1/live-voice");
    expect(url.hash).toBe("");
    expect(url.searchParams.get("a")).toBeNull();
    expect(url.searchParams.get("token")).toBeNull();
    expect(url.searchParams.get("conversationId")).toBe("conv-xyz");
  });

  test("a plain-HTTP ingress dials over ws so a local origin is reachable", () => {
    const url = new URL(
      buildGatewayWsUrl({ ...args, ingressUrl: "http://localhost:8500" }),
    );
    expect(url.protocol).toBe("ws:");
    expect(url.host).toBe("localhost:8500");
    expect(url.pathname).toBe("/v1/assistants/asst-1/live-voice");
  });

  test("the paired plane's actor token rides in ?token= when provided", () => {
    const url = new URL(
      buildGatewayWsUrl({
        ...args,
        ingressUrl: "https://app.example",
        token: "actor-tok",
      }),
    );
    expect(url.searchParams.get("token")).toBe("actor-tok");
  });

  test("a path-prefixed ingress keeps its prefix; the route's /v1 folds into the scoped family", () => {
    const url = new URL(
      buildGatewayWsUrl({
        ...args,
        ingressUrl: "https://x.ngrok-free.app/gw?a=1#frag",
        token: "actor-tok",
      }),
    );
    expect(url.protocol).toBe("wss:");
    expect(url.host).toBe("x.ngrok-free.app");
    expect(url.pathname).toBe("/gw/v1/assistants/asst-1/live-voice");
    expect(url.hash).toBe("");
    expect(url.searchParams.get("a")).toBeNull();
    expect(url.searchParams.get("token")).toBe("actor-tok");
  });
});

// ---------------------------------------------------------------------------
// resolveGatewayWsUrl: the routing every gateway WS shares
// ---------------------------------------------------------------------------
describe("resolveGatewayWsUrl", () => {
  const args = {
    assistantId: "asst-1",
    routePath: "/v1/desktop/stream",
  };

  test("self-hosted: dials the scoped path on the ingress and mints nothing", async () => {
    setSelfHostedConnection({
      url: "http://localhost:8500",
      token: "actor-jwt",
    });

    const url = new URL(await resolveGatewayWsUrl(args));

    expect(url.origin).toBe("ws://localhost:8500");
    expect(url.pathname).toBe("/v1/assistants/asst-1/desktop/stream");
    expect(url.searchParams.get("token")).toBe("actor-jwt");
    expect(captured).toBeNull();
  });

  test("self-hosted: dials without a token when none is provisioned — the host injects", async () => {
    setSelfHostedConnection({ url: "http://localhost:8500", token: null });

    const url = new URL(await resolveGatewayWsUrl(args));

    expect(url.pathname).toBe("/v1/assistants/asst-1/desktop/stream");
    expect(url.searchParams.has("token")).toBe(false);
    expect(captured).toBeNull();
  });

  test("managed: mints a tunnel token and dials tunnel with it, params included", async () => {
    const url = new URL(
      await resolveGatewayWsUrl({ ...args, params: { sampleRate: "16000" } }),
    );

    expect(captured?.body).toEqual({ assistantId: "asst-1" });
    expect(url.protocol).toBe("wss:");
    expect(url.host).toBe("tunnel.mycadet.ai");
    // The `/<assistantId>` prefix selects the tunnel; tunnel strips it to
    // recover the upstream path it matches its allowlist against.
    expect(url.pathname).toBe("/asst-1/v1/desktop/stream");
    expect(url.searchParams.get("token")).toBe("tok-abc");
    expect(url.searchParams.get("sampleRate")).toBe("16000");
  });
});

// ---------------------------------------------------------------------------
// resolveLiveVoiceWsUrl — transport routing (cloud vs self-hosted)
// ---------------------------------------------------------------------------
describe("resolveLiveVoiceWsUrl", () => {
  test("cloud path: mints a tunnel token and builds the tunnel URL", async () => {
    // GIVEN no self-hosted ingress (default)
    const raw = await resolveLiveVoiceWsUrl({
      assistantId: "assistant-1",
      conversationId: "conv-xyz",
    });

    // THEN it mints and dials tunnel with the assistantId path prefix
    expect(captured?.url).toBe("/v1/auth/live-voice-token/");
    const url = new URL(raw);
    expect(url.host).toBe("tunnel.mycadet.ai");
    expect(url.pathname).toBe("/assistant-1/v1/live-voice");
    expect(url.searchParams.get("token")).toBe("tok-abc");
    expect(url.searchParams.get("conversationId")).toBe("conv-xyz");
  });

  /**
   * A session with no conversation named starts one rather than joining a
   * thread, so the parameter has to be absent, not present and empty.
   */
  test("cloud path: omits conversationId when none is given", async () => {
    const raw = await resolveLiveVoiceWsUrl({ assistantId: "assistant-1" });

    expect(new URL(raw).searchParams.has("conversationId")).toBe(false);
  });

  test("self-hosted path: dials the scoped path with the actor token, no mint", async () => {
    // GIVEN a primed self-hosted connection
    setSelfHostedConnection({
      url: "https://x.ngrok-free.app",
      token: "actor-tok",
    });

    const raw = await resolveLiveVoiceWsUrl({
      assistantId: "assistant-1",
      conversationId: "conv-xyz",
    });

    // THEN no tunnel token is minted...
    expect(captured).toBeNull();
    // ...and the URL targets the gateway's scoped route with the actor token
    const url = new URL(raw);
    expect(url.protocol).toBe("wss:");
    expect(url.host).toBe("x.ngrok-free.app");
    expect(url.pathname).toBe("/v1/assistants/assistant-1/live-voice");
    expect(url.searchParams.get("token")).toBe("actor-tok");
    expect(url.searchParams.get("conversationId")).toBe("conv-xyz");
  });

  test("self-hosted with no actor token dials without one (and does not mint)", async () => {
    // GIVEN an ingress is known but no actor token is provisioned — a local
    // assistant's serving host injects the credential on the proxied upgrade.
    setSelfHostedConnection({ url: "http://localhost:8500", token: null });

    const raw = await resolveLiveVoiceWsUrl({ assistantId: "assistant-1" });

    const url = new URL(raw);
    expect(url.searchParams.has("token")).toBe(false);
    expect(captured).toBeNull();
  });
});
