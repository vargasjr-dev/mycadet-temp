import type { Fetch } from "@mycadet/shared/fetch";
import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

import * as localModeShared from "@mycadet/local-mode";
import { PROXY_ERROR_HEADER, PROXY_NETWORK_ERROR_CODE } from "./cloud-forward";

type TokenResult =
  | { ok: true; accessToken: string }
  | { ok: false; status: number; error: string };

// The planner reads its target map from the watched lockfile snapshot (the
// watcher seam) and resolves the paired guardian bearer and the local
// guardian lease through electron-desktop's local-mode module — both are
// module-level dependencies of `forwardGatewayRequest`, pinned here so tests
// never touch disk.
let watchedSnapshot: { assistants: unknown[] } | null = null;
mock.module("./lockfile-watcher", () => ({
  getWatchedLockfileSnapshot: () => watchedSnapshot,
}));

let tokenResult: TokenResult = { ok: true, accessToken: "host-token" };
const getStoredPairedGuardianAccessToken = mock(
  async (_assistantId: string, _runtimeUrl: string): Promise<TokenResult> =>
    tokenResult,
);
let localTokenResult: TokenResult = { ok: true, accessToken: "local-guardian" };
const getGuardianAccessToken = mock(
  async (_assistantId: string): Promise<TokenResult> => localTokenResult,
);
mock.module("@mycadet/local-mode", () => ({
  ...localModeShared,
  getGuardianAccessToken,
  getPairedGuardianAccessToken: getStoredPairedGuardianAccessToken,
}));

const { forwardGatewayRequest } = await import("./gateway-forward");
const { clearLoopbackGatewayBearerCache } = await import("@mycadet/local-mode");

const request = (path: string, init: RequestInit = {}) =>
  new Request(`app://mycadet.ai${path}`, init);

const MINTED_BEARER = "host-minted-bearer";

/**
 * The network seam for a loopback test: the executor's bearer mint dials the
 * same fetcher as the forward itself, so the recorder answers the mint route
 * with a canned mint body and everything else with the test's response.
 * Every call is recorded in order.
 */
const recorder = (response = new Response("ok")) => {
  const calls: Array<{
    url: string;
    init?: RequestInit & { duplex?: "half" };
  }> = [];
  const fetcher: (
    url: string,
    init?: RequestInit,
  ) => Promise<Response> = async (url, init) => {
    calls.push({ url, init });
    if (new URL(url).pathname === "/auth/token") {
      return Response.json({
        token: MINTED_BEARER,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      });
    }
    return response;
  };
  return { fetcher, calls, response };
};

const localLockfile = {
  assistants: [
    {
      assistantId: "abc",
      cloud: "local",
      resources: { gatewayPort: 8080, daemonPort: 8501 },
    },
  ],
};
const pairedLockfile = {
  assistants: [
    {
      assistantId: "abc",
      cloud: "paired",
      runtimeUrl: "https://gw.example.com",
    },
  ],
};

beforeEach(() => {
  tokenResult = { ok: true, accessToken: "host-token" };
  localTokenResult = { ok: true, accessToken: "local-guardian" };
  getStoredPairedGuardianAccessToken.mockClear();
  getGuardianAccessToken.mockClear();
  clearLoopbackGatewayBearerCache();
});

describe("forwardGatewayRequest — loopback forwards", () => {
  beforeEach(() => {
    watchedSnapshot = localLockfile;
  });

  test("passes non-gateway requests through without fetching", async () => {
    const { fetcher, calls } = recorder();
    expect(
      await forwardGatewayRequest(request("/assistant/assets/app.js"), fetcher),
    ).toBeNull();
    expect(calls).toHaveLength(0);
    expect(getStoredPairedGuardianAccessToken).not.toHaveBeenCalled();
    expect(getGuardianAccessToken).not.toHaveBeenCalled();
  });

  test("rejects an id that is not active in the lockfile before fetching", async () => {
    const { fetcher, calls } = recorder();
    const response = await forwardGatewayRequest(
      request("/__gateway/unknown/v1"),
      fetcher,
    );
    expect(response?.status).toBe(403);
    expect(await response?.text()).toBe("Assistant is not active in lockfile");
    expect(getStoredPairedGuardianAccessToken).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  test("passes a scoped path for an unknown id through to the generic /v1 arm", async () => {
    const { fetcher, calls } = recorder();
    expect(
      await forwardGatewayRequest(
        request("/v1/assistants/unknown/messages"),
        fetcher,
      ),
    ).toBeNull();
    expect(calls).toHaveLength(0);
    expect(getStoredPairedGuardianAccessToken).not.toHaveBeenCalled();
  });

  test("forwards the scoped SDK surface verbatim to the recorded port", async () => {
    const { fetcher, response, calls } = recorder();
    expect(
      await forwardGatewayRequest(
        request("/v1/assistants/abc/conversations?x=1"),
        fetcher,
      ),
    ).toBe(response);
    const forwards = calls.filter(
      ({ url }) => !new URL(url).pathname.endsWith("/auth/token"),
    );
    expect(forwards).toHaveLength(1);
    const { url, init } = forwards[0]!;
    expect(url).toBe(
      "http://127.0.0.1:8080/v1/assistants/abc/conversations?x=1",
    );
    expect(init!.method).toBe("GET");
  });

  test("flattens the contact family in the scoped forward", async () => {
    const { fetcher, calls } = recorder();
    await forwardGatewayRequest(
      request("/v1/assistants/abc/contacts/x"),
      fetcher,
    );
    const forwards = calls.filter(
      ({ url }) => !new URL(url).pathname.endsWith("/auth/token"),
    );
    expect(forwards[0]!.url).toBe("http://127.0.0.1:8080/v1/contacts/x");
  });

  test("forwards to the recorded loopback port and preserves the query", async () => {
    const { fetcher, response, calls } = recorder();
    expect(
      await forwardGatewayRequest(
        request("/assistant/__gateway/abc/v1/assistants?x=1"),
        fetcher,
      ),
    ).toBe(response);
    const forwards = calls.filter(
      ({ url }) => !new URL(url).pathname.endsWith("/auth/token"),
    );
    expect(forwards).toHaveLength(1);
    const { url, init } = forwards[0]!;
    expect(url).toBe("http://127.0.0.1:8080/v1/assistants?x=1");
    expect(init!.method).toBe("GET");
    expect(init!.body).toBeUndefined();
    expect(init!.duplex).toBeUndefined();
  });

  test("mints and injects the host-owned bearer on scoped forwards", async () => {
    const { fetcher, response, calls } = recorder();
    await forwardGatewayRequest(
      request("/v1/assistants/abc/conversations"),
      fetcher,
    );

    expect(getGuardianAccessToken).toHaveBeenCalledWith("abc");
    const forwards = calls.filter(
      ({ url }) => !new URL(url).pathname.endsWith("/auth/token"),
    );
    const headers = new Headers(forwards[0]!.init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${MINTED_BEARER}`);
    expect(response.bodyUsed).toBe(false);
  });

  test("strips the renderer's bearer and other credentials never cross", async () => {
    const { fetcher, calls } = recorder();
    await forwardGatewayRequest(
      request("/v1/assistants/abc/conversations", {
        headers: { authorization: "Bearer renderer-minted-token" },
      }),
      fetcher,
    );
    const forwards = calls.filter(
      ({ url }) => !new URL(url).pathname.endsWith("/auth/token"),
    );
    const headers = new Headers(forwards[0]!.init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${MINTED_BEARER}`);
  });

  test("leaves the mint route itself stripped and uninjected", async () => {
    const { fetcher, calls } = recorder();
    await forwardGatewayRequest(
      request("/__gateway/abc/auth/token", {
        method: "POST",
        headers: {
          origin: "app://mycadet.ai",
          authorization: "Bearer guardian-token",
        },
      }),
      fetcher,
    );
    // The mint route's own bearer contract is the guardian token, which the
    // planner strips like any renderer credential — and nothing dials the
    // route through this forward anymore, so no data-plane bearer is
    // injected either. A straggler dial gets the gateway's own 401.
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(new URL(url).pathname).toBe("/auth/token");
    const headers = new Headers(init!.headers);
    expect(headers.get("authorization")).toBeNull();
    expect(getGuardianAccessToken).not.toHaveBeenCalled();
  });

  test("sets loopback Origin when renderer Origin is app://mycadet.ai", async () => {
    const { fetcher, calls } = recorder();
    await forwardGatewayRequest(
      request("/__gateway/abc/auth/token", {
        method: "POST",
        headers: { origin: "app://mycadet.ai" },
      }),
      fetcher,
    );
    expect(new Headers(calls[0]!.init?.headers).get("origin")).toBe(
      "http://127.0.0.1:8080",
    );
  });

  test("forwards a half-duplex streamed body with manual redirects", async () => {
    const { fetcher, calls } = recorder();
    const req = request("/__gateway/abc/v1/foo", {
      method: "POST",
      body: new ReadableStream<Uint8Array>(),
    });
    await forwardGatewayRequest(req, fetcher);
    const forwards = calls.filter(
      ({ url }) => !new URL(url).pathname.endsWith("/auth/token"),
    );
    const init = forwards[0]!.init;
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(req.body);
    expect(init?.duplex).toBe("half");
    expect(init?.redirect).toBe("manual");
  });

  test("re-mints once and retries a bodyless forward the gateway 401s", async () => {
    let forwards = 0;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: (
      url: string,
      init?: RequestInit,
    ) => Promise<Response> = async (url, init) => {
      calls.push({ url, init });
      if (new URL(url).pathname === "/auth/token") {
        return Response.json({
          token: forwards === 0 ? MINTED_BEARER : "re-minted-bearer",
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        });
      }
      forwards += 1;
      return forwards === 1
        ? new Response("Unauthorized", { status: 401 })
        : new Response("ok");
    };

    const response = await forwardGatewayRequest(
      request("/v1/assistants/abc/conversations"),
      fetcher,
    );

    expect(response?.status).toBe(200);
    // Calls: the mint, the rejected forward, the re-mint, the retry.
    const forwardHeaders = new Headers(calls[3]!.init?.headers);
    expect(forwardHeaders.get("authorization")).toBe("Bearer re-minted-bearer");
  });

  test("does not retry a bodied forward the gateway 401s", async () => {
    let forwards = 0;
    const fetcher: (
      url: string,
      init?: RequestInit,
    ) => Promise<Response> = async (url) => {
      if (new URL(url).pathname === "/auth/token") {
        return Response.json({
          token: MINTED_BEARER,
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
        });
      }
      forwards += 1;
      return new Response("Unauthorized", { status: 401 });
    };

    const response = await forwardGatewayRequest(
      request("/v1/assistants/abc/conversations", {
        method: "POST",
        body: new ReadableStream<Uint8Array>(),
      }),
      fetcher,
    );

    expect(response?.status).toBe(401);
    expect(forwards).toBe(1);
  });

  test("forwards without a bearer when the mint fails", async () => {
    localTokenResult = { ok: false, status: 404, error: "no guardian token" };
    const { fetcher, calls } = recorder(new Response("{}", { status: 200 }));

    const response = await forwardGatewayRequest(
      request("/v1/assistants/abc/conversations"),
      fetcher,
    );

    // The gateway's own response surfaces the truth (readyz stays reachable;
    // protected routes answer 401 unauthenticated).
    expect(response?.status).toBe(200);
    const forwards = calls.filter(
      ({ url }) => !new URL(url).pathname.endsWith("/auth/token"),
    );
    expect(
      new Headers(forwards[0]!.init?.headers).get("authorization"),
    ).toBeNull();
  });

  test("propagates loopback fetch failures without retrying", async () => {
    const fetcher = mock(async () => {
      throw new Error("net::ERR_CONNECTION_REFUSED");
    });
    await expect(
      Promise.resolve().then(() =>
        forwardGatewayRequest(request("/__gateway/abc/v1/foo"), fetcher),
      ),
    ).rejects.toThrow("net::ERR_CONNECTION_REFUSED");
    // The mint attempt plus the forward attempt, no retry.
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("forwardGatewayRequest — remote (paired) forwards", () => {
  beforeEach(() => {
    watchedSnapshot = pairedLockfile;
  });

  test("forwards to the paired runtime with its host-owned bearer and query", async () => {
    const { fetcher, calls } = recorder();
    await forwardGatewayRequest(
      request("/__gateway/abc/v1/foo?x=1", {
        headers: {
          authorization: "Bearer renderer-token",
          accept: "text/event-stream",
        },
      }),
      fetcher,
    );
    expect(getStoredPairedGuardianAccessToken).toHaveBeenCalledWith(
      "abc",
      "https://gw.example.com",
    );
    const { url, init } = calls[0]!;
    expect(url).toBe("https://gw.example.com/v1/foo?x=1");
    expect(init!.redirect).toBe("manual");
    const headers = new Headers(init!.headers);
    expect(headers.get("authorization")).toBe("Bearer host-token");
    expect(headers.get("accept")).toBe("text/event-stream");
  });

  test("strips browser-ambient headers and streams the request body", async () => {
    const { fetcher, calls } = recorder();
    const req = request("/__gateway/abc/v1/events", {
      method: "POST",
      headers: {
        origin: "app://mycadet.ai",
        referer: "app://mycadet.ai/assistant",
        cookie: "sessionid=abc",
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
      },
      body: new ReadableStream<Uint8Array>(),
    });
    await forwardGatewayRequest(req, fetcher);
    const init = calls[0]!.init!;
    const headers = new Headers(init.headers);
    for (const name of [
      "origin",
      "referer",
      "cookie",
      "sec-fetch-site",
      "sec-fetch-mode",
    ]) {
      expect(headers.has(name)).toBe(false);
    }
    expect(init.method).toBe("POST");
    expect(init.body).toBe(req.body);
    expect(init.duplex).toBe("half");
  });

  test("rejects before fetching when the host cannot read the bearer", async () => {
    const { fetcher, calls } = recorder();
    tokenResult = { ok: false, status: 404, error: "Guardian token not found" };
    const response = await forwardGatewayRequest(
      request("/__gateway/abc/v1/foo"),
      fetcher,
    );
    expect(response?.status).toBe(404);
    expect(await response?.text()).toBe("Guardian token not found");
    expect(calls).toHaveLength(0);
  });

  test("returns the upstream streaming Response without consuming it", async () => {
    const upstream = new Response(new ReadableStream<Uint8Array>(), {
      headers: { "content-type": "text/event-stream" },
    });
    const { fetcher } = recorder(upstream);
    expect(
      await forwardGatewayRequest(request("/__gateway/abc/v1/events"), fetcher),
    ).toBe(upstream);
    expect(upstream.bodyUsed).toBe(false);
  });

  test.each([
    ["GET", "net::ERR_TUNNEL_CONNECTION_FAILED", 1],
    ["GET", "net::ERR_NETWORK_CHANGED", 2],
    ["POST", "net::ERR_NETWORK_CHANGED", 1],
  ] as const)(
    "handles %s failure %s with %i attempts",
    async (method, message, attempts) => {
      const log = spyOn(console, "error").mockImplementation(() => {});
      try {
        const fetcher = mock(async () => {
          throw new Error(message);
        });
        const response = await forwardGatewayRequest(
          request("/__gateway/abc/v1/foo", { method }),
          fetcher,
        );
        expect(fetcher).toHaveBeenCalledTimes(attempts);
        expect(response?.status).toBe(502);
        expect(response?.headers.get("content-type")).toBe("application/json");
        expect(response?.headers.get(PROXY_ERROR_HEADER)).toBe("network");
        expect(await response?.json()).toEqual({
          code: PROXY_NETWORK_ERROR_CODE,
          detail: expect.any(String),
        });
        expect(log).toHaveBeenCalledTimes(attempts);
      } finally {
        log.mockRestore();
      }
    },
  );
});
