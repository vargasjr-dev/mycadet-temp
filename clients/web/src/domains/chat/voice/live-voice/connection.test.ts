/**
 * Tests for the live-voice WS connection + token-exchange client.
 *
 * Two surfaces under test:
 *   - `mintTunnelWsToken` — must POST `/v1/auth/live-voice-token/` same-origin
 *     with the session credentials. We stub `fetch` and capture the request
 *     rather than `mock.module`-ing anything, matching the pattern in
 *     `domains/chat/inspector/compaction-trail-fetch.test.ts`.
 *   - `buildTunnelWsUrl` / `buildGatewayWsUrl` and the resolvers on top of
 *     them: the cloud tunnel URL carries the `assistantId` in the path, a
 *     URL-encoded `?token=`, and the `wss` scheme; the self-hosted URL rides
 *     the scoped shape on the ingress origin.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  buildGatewayWsUrl,
  buildTunnelWsUrl,
  GatewayWsIngressError,
  getTunnelWsScheme,
  TunnelWsTokenError,
  mintTunnelWsToken,
  resolveGatewayWsUrl,
  resolveLiveVoiceWsUrl,
} from "./connection";

// ---------------------------------------------------------------------------
// mintTunnelWsToken
// ---------------------------------------------------------------------------

interface CapturedMintRequest {
  url: string;
  init: RequestInit;
}

let captured: CapturedMintRequest | null = null;
let nextMintResponse: Response;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  captured = null;
  nextMintResponse = Response.json(
    { token: "tok-abc", expiresAt: "2026-06-01T00:05:00Z" },
    { status: 200 },
  );
  const storyFetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    captured = {
      url: input instanceof Request ? input.url : String(input),
      init: init ?? {},
    };
    return nextMintResponse;
  });
  globalThis.fetch = Object.assign(storyFetch, {
    preconnect: () => {},
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  window.__CADET_CONFIG__ = undefined;
});

describe("mintTunnelWsToken", () => {
  test("POSTs the documented mint endpoint with the assistantId body", async () => {
    await mintTunnelWsToken("assistant-1");

    expect(captured).not.toBeNull();
    expect(captured!.url).toBe("/v1/auth/live-voice-token/");
    expect(captured!.init.method).toBe("POST");
    expect(JSON.parse(captured!.init.body as string)).toEqual({
      assistantId: "assistant-1",
    });
  });

  test("returns { token, expiresAt } from the response", async () => {
    const result = await mintTunnelWsToken("assistant-1");
    expect(result).toEqual({
      token: "tok-abc",
      expiresAt: "2026-06-01T00:05:00Z",
    });
  });

  test("throws TunnelWsTokenError with the HTTP status on non-OK", async () => {
    nextMintResponse = Response.json({ detail: "forbidden" }, { status: 403 });

    try {
      await mintTunnelWsToken("assistant-1");
      throw new Error("expected mintTunnelWsToken to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(TunnelWsTokenError);
      expect((err as TunnelWsTokenError).status).toBe(403);
    }
  });

  test("throws TunnelWsTokenError(0) when the body is malformed", async () => {
    nextMintResponse = Response.json(
      { token: "tok-abc" }, // missing expiresAt
      { status: 200 },
    );

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

  test("derives the tunnel host from the page's own origin, falling back to prod off-convention", () => {
    // The single-origin plan: no injected URL — the origin the page is
    // served AT decides. The test env's origin (localhost) matches no
    // platform convention, so the prod tunnel is the answer. The
    // convention mapping itself is tunnelHostForCloudHost's own tests.
    const url = new URL(buildTunnelWsUrl({ ...args, token: "tok-abc" }));
    expect(url.protocol).toBe("wss:");
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

  test("a non-HTTP(S) ingress refuses instead of scheme-swapping to a foreign host", () => {
    expect(() =>
      buildGatewayWsUrl({ ...args, ingressUrl: "app://mycadet.ai" }),
    ).toThrow(GatewayWsIngressError);
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

  // The self-hosted ingress branch is gone — the resolver always mints,
  // so the managed case below is the only dial shape left.
  test("managed: mints a tunnel token and dials tunnel with it, params included", async () => {
    const url = new URL(
      await resolveGatewayWsUrl({ ...args, params: { sampleRate: "16000" } }),
    );

    expect(JSON.parse(captured!.init.body as string)).toEqual({
      assistantId: "asst-1",
    });
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
// resolveLiveVoiceWsUrl — the transport every live-voice session shares
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

});
