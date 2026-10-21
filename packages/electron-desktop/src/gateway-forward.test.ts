import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

import { PROXY_ERROR_HEADER, PROXY_NETWORK_ERROR_CODE } from "./cloud-forward";
import type { GatewayForwardFetcher } from "./gateway-forward";

type TokenResult =
  | { ok: true; accessToken: string }
  | { ok: false; status: number; error: string };

// The planner reads its target map from the watched lockfile snapshot (the
// watcher seam) and resolves the paired guardian bearer through
// electron-desktop's local-mode module — both are module-level dependencies
// of `forwardGatewayRequest`, pinned here so tests never touch disk.
let watchedSnapshot: { assistants: unknown[] } | null = null;
mock.module("./lockfile-watcher", () => ({
  getWatchedLockfileSnapshot: () => watchedSnapshot,
}));

let tokenResult: TokenResult = { ok: true, accessToken: "host-token" };
const getPairedGuardianAccessToken = mock(
  async (_assistantId: string, _runtimeUrl: string): Promise<TokenResult> =>
    tokenResult,
);
mock.module("./local-mode", () => ({ getPairedGuardianAccessToken }));

const { forwardGatewayRequest } = await import("./gateway-forward");

const request = (path: string, init: RequestInit = {}) =>
  new Request(`app://mycadet.ai${path}`, init);
const recorder = (response = new Response("ok")) => {
  const fetcher = mock<GatewayForwardFetcher>(async () => response);
  return { fetcher, response };
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
  getPairedGuardianAccessToken.mockClear();
});

describe("forwardGatewayRequest — loopback forwards", () => {
  beforeEach(() => {
    watchedSnapshot = localLockfile;
  });

  test("passes non-gateway requests through without fetching", async () => {
    const { fetcher } = recorder();
    expect(
      await forwardGatewayRequest(request("/assistant/assets/app.js"), fetcher),
    ).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    expect(getPairedGuardianAccessToken).not.toHaveBeenCalled();
  });

  test("rejects an id that is not active in the lockfile before fetching", async () => {
    const { fetcher } = recorder();
    const response = await forwardGatewayRequest(
      request("/__gateway/unknown/v1"),
      fetcher,
    );
    expect(response?.status).toBe(403);
    expect(await response?.text()).toBe("Assistant is not active in lockfile");
    expect(getPairedGuardianAccessToken).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  test("passes a scoped path for an unknown id through to the generic /v1 arm", async () => {
    const { fetcher } = recorder();
    expect(
      await forwardGatewayRequest(
        request("/v1/assistants/unknown/messages"),
        fetcher,
      ),
    ).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    expect(getPairedGuardianAccessToken).not.toHaveBeenCalled();
  });

  test("forwards the scoped SDK surface verbatim to the recorded port", async () => {
    const { fetcher, response } = recorder();
    expect(
      await forwardGatewayRequest(
        request("/v1/assistants/abc/conversations?x=1"),
        fetcher,
      ),
    ).toBe(response);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(
      "http://127.0.0.1:8080/v1/assistants/abc/conversations?x=1",
    );
    expect(init.method).toBe("GET");
  });

  test("flattens the contact family in the scoped forward", async () => {
    const { fetcher } = recorder();
    await forwardGatewayRequest(
      request("/v1/assistants/abc/contacts/x"),
      fetcher,
    );
    expect(fetcher.mock.calls[0]![0]).toBe(
      "http://127.0.0.1:8080/v1/contacts/x",
    );
  });

  test("forwards to the recorded loopback port and preserves the query", async () => {
    const { fetcher, response } = recorder();
    expect(
      await forwardGatewayRequest(
        request("/assistant/__gateway/abc/v1/assistants?x=1"),
        fetcher,
      ),
    ).toBe(response);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8080/v1/assistants?x=1");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(init.duplex).toBeUndefined();
  });

  test.each([undefined, "app://mycadet.ai"])(
    "sets loopback Origin when renderer Origin is %s",
    async (origin) => {
      const { fetcher } = recorder();
      await forwardGatewayRequest(
        request("/__gateway/abc/auth/token", {
          method: "POST",
          headers: origin ? { origin } : {},
        }),
        fetcher,
      );
      expect(new Headers(fetcher.mock.calls[0]![1].headers).get("origin")).toBe(
        "http://127.0.0.1:8080",
      );
    },
  );

  test("preserves the renderer-minted gateway bearer and other headers", async () => {
    const { fetcher } = recorder();
    await forwardGatewayRequest(
      request("/__gateway/abc/auth/token", {
        method: "POST",
        headers: {
          origin: "app://mycadet.ai",
          authorization: "Bearer gateway-token",
          "content-type": "application/json",
        },
      }),
      fetcher,
    );
    const headers = new Headers(fetcher.mock.calls[0]![1].headers);
    expect(headers.get("authorization")).toBe("Bearer gateway-token");
    expect(headers.get("content-type")).toBe("application/json");
  });

  test("forwards a half-duplex streamed body with manual redirects", async () => {
    const { fetcher } = recorder();
    const req = request("/__gateway/abc/v1/foo", {
      method: "POST",
      body: new ReadableStream<Uint8Array>(),
    });
    await forwardGatewayRequest(req, fetcher);
    const init = fetcher.mock.calls[0]![1];
    expect(init.method).toBe("POST");
    expect(init.body).toBe(req.body);
    expect(init.duplex).toBe("half");
    expect(init.redirect).toBe("manual");
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
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("forwardGatewayRequest — remote (paired) forwards", () => {
  beforeEach(() => {
    watchedSnapshot = pairedLockfile;
  });

  test("forwards to the paired runtime with its host-owned bearer and query", async () => {
    const { fetcher } = recorder();
    await forwardGatewayRequest(
      request("/__gateway/abc/v1/foo?x=1", {
        headers: {
          authorization: "Bearer renderer-token",
          accept: "text/event-stream",
        },
      }),
      fetcher,
    );
    expect(getPairedGuardianAccessToken).toHaveBeenCalledWith(
      "abc",
      "https://gw.example.com",
    );
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://gw.example.com/v1/foo?x=1");
    expect(init.redirect).toBe("manual");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer host-token");
    expect(headers.get("accept")).toBe("text/event-stream");
  });

  test("strips browser-ambient headers and streams the request body", async () => {
    const { fetcher } = recorder();
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
    const init = fetcher.mock.calls[0]![1];
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
    const { fetcher } = recorder();
    tokenResult = { ok: false, status: 404, error: "Guardian token not found" };
    const response = await forwardGatewayRequest(
      request("/__gateway/abc/v1/foo"),
      fetcher,
    );
    expect(response?.status).toBe(404);
    expect(await response?.text()).toBe("Guardian token not found");
    expect(fetcher).not.toHaveBeenCalled();
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
