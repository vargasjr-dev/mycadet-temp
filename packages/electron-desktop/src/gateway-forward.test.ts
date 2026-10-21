import { describe, expect, mock, spyOn, test } from "bun:test";

import {
  forwardGatewayRequest,
  forwardPairedGatewayRequest,
  type GatewayForwardFetcher,
} from "./gateway-forward";
import { PROXY_ERROR_HEADER, PROXY_NETWORK_ERROR_CODE } from "./cloud-forward";

const allow =
  (...ports: number[]) =>
  () =>
    new Set(ports);
const pair =
  (entries: Record<string, string> = { abc: "https://gw.example.com" }) =>
  () =>
    new Map(Object.entries(entries));
const guardianToken = async () => ({
  ok: true as const,
  accessToken: "host-token",
});
const request = (path: string, init: RequestInit = {}) =>
  new Request(`app://mycadet.ai${path}`, init);
const recorder = (response = new Response("ok")) => {
  const fetcher = mock<GatewayForwardFetcher>(async () => response);
  return { fetcher, response };
};

describe("forwardGatewayRequest", () => {
  test("passes non-gateway requests through without fetching", async () => {
    const { fetcher } = recorder();
    expect(
      await forwardGatewayRequest(
        request("/assistant/assets/app.js"),
        allow(8080),
        fetcher,
      ),
    ).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  test.each([
    ["/__gateway/80/v1", 400, "Port must be between 1024 and 65535"],
    ["/__gateway/9999/v1", 403, "Gateway port is not active in lockfile"],
  ] as const)("rejects %s before fetching", async (path, status, message) => {
    const { fetcher } = recorder();
    const response = await forwardGatewayRequest(
      request(path),
      allow(80, 8080),
      fetcher,
    );
    expect(response?.status).toBe(status);
    expect(await response?.text()).toBe(message);
    expect(fetcher).not.toHaveBeenCalled();
  });

  test("forwards an allowlisted port and preserves the query", async () => {
    const { fetcher, response } = recorder();
    expect(
      await forwardGatewayRequest(
        request("/assistant/__gateway/8080/v1/assistants?x=1"),
        allow(8080),
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
        request("/__gateway/8080/auth/token", {
          method: "POST",
          headers: origin ? { origin } : {},
        }),
        allow(8080),
        fetcher,
      );
      expect(new Headers(fetcher.mock.calls[0]![1].headers).get("origin")).toBe(
        "http://127.0.0.1:8080",
      );
    },
  );

  test("preserves non-Origin headers", async () => {
    const { fetcher } = recorder();
    await forwardGatewayRequest(
      request("/__gateway/8080/auth/token", {
        method: "POST",
        headers: {
          origin: "app://mycadet.ai",
          authorization: "Bearer guardian-token",
          "content-type": "application/json",
        },
      }),
      allow(8080),
      fetcher,
    );
    const headers = new Headers(fetcher.mock.calls[0]![1].headers);
    expect(headers.get("authorization")).toBe("Bearer guardian-token");
    expect(headers.get("content-type")).toBe("application/json");
  });

  test("forwards a half-duplex streamed body with manual redirects", async () => {
    const { fetcher } = recorder();
    const req = request("/__gateway/8080/v1/foo", {
      method: "POST",
      body: new ReadableStream<Uint8Array>(),
    });
    await forwardGatewayRequest(req, allow(8080), fetcher);
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
        forwardGatewayRequest(
          request("/__gateway/8080/v1/foo"),
          allow(8080),
          fetcher,
        ),
      ),
    ).rejects.toThrow("net::ERR_CONNECTION_REFUSED");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("forwardPairedGatewayRequest", () => {
  test.each(["/assistant/assets/app.js", "/__gateway/8080/v1"])(
    "passes %s through without credentials or fetching",
    async (path) => {
      const { fetcher } = recorder();
      const token = mock(guardianToken);
      expect(
        await forwardPairedGatewayRequest(
          request(path),
          pair(),
          token,
          fetcher,
        ),
      ).toBeNull();
      expect(token).not.toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  test.each([
    "/__gateway-paired/unknown/v1",
    "/__gateway-paired/abc/%2e%2e/secrets",
  ])("rejects %s before credentials or fetching", async (path) => {
    const { fetcher } = recorder();
    const token = mock(guardianToken);
    const response = await forwardPairedGatewayRequest(
      request(path),
      pair({ abc: "https://gw.example.com/edge" }),
      token,
      fetcher,
    );
    expect(response?.status).toBe(403);
    expect(await response?.text()).toBe("Assistant is not paired in lockfile");
    expect(token).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  test("forwards to the paired runtime with its host-owned bearer and query", async () => {
    const { fetcher } = recorder();
    const token = mock(guardianToken);
    await forwardPairedGatewayRequest(
      request("/assistant/__gateway-paired/abc/v1/foo?x=1", {
        headers: {
          authorization: "Bearer renderer-token",
          accept: "text/event-stream",
        },
      }),
      pair(),
      token,
      fetcher,
    );
    expect(token).toHaveBeenCalledWith("abc", "https://gw.example.com");
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://gw.example.com/v1/foo?x=1");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(init.duplex).toBeUndefined();
    expect(init.redirect).toBe("manual");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer host-token");
    expect(headers.get("accept")).toBe("text/event-stream");
  });

  test("strips browser-ambient headers and streams the request body", async () => {
    const { fetcher } = recorder();
    const req = request("/__gateway-paired/abc/v1/events", {
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
    await forwardPairedGatewayRequest(req, pair(), guardianToken, fetcher);
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
    const response = await forwardPairedGatewayRequest(
      request("/__gateway-paired/abc/v1/foo"),
      pair(),
      async () => ({
        ok: false,
        status: 404,
        error: "Guardian token not found",
      }),
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
      await forwardPairedGatewayRequest(
        request("/__gateway-paired/abc/v1/events"),
        pair(),
        guardianToken,
        fetcher,
      ),
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
        const response = await forwardPairedGatewayRequest(
          request("/__gateway-paired/abc/v1/foo", { method }),
          pair(),
          guardianToken,
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
