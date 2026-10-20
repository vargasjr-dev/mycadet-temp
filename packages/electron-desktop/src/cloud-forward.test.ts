import { describe, expect, test } from "bun:test";

import {
  buildProxyNetworkErrorResponse,
  fetchForwardPlanWithRetry,
  forwardCloudRequest,
  isTransientNetworkError,
  PROXY_ERROR_HEADER,
  PROXY_NETWORK_ERROR_CODE,
  type CloudForwardFetcher,
} from "./cloud-forward";

const PLATFORM = "https://cloud.mycadet.ai";
const GATEWAY = "http://127.0.0.1:20100";
const ELECTRON_RENDERER_ORIGIN_HEADER = "X-Cadet-Electron-Renderer-Origin";
const allowedOrigin = { protocol: "app:", host: "mycadet.ai" };

const request = (
  pathname: string,
  init: {
    method?: string;
    origin?: string;
    headers?: Record<string, string>;
  } = {},
) => ({
  url: `app://mycadet.ai${pathname}`,
  method: init.method ?? "GET",
  headers: new Headers({
    ...(init.origin !== undefined ? { origin: init.origin } : {}),
    ...init.headers,
  }),
  body: null,
});

/** Fake fetcher recording what the forward would have sent. */
const recorder = () => {
  const calls: Array<{
    url: string;
    init: RequestInit & { duplex?: "half" };
  }> = [];
  const fetcher: CloudForwardFetcher = async (url, init) => {
    calls.push({ url, init });
    return new Response("forwarded", { status: 200 });
  };
  return { calls, fetcher };
};

const header = (init: RequestInit | undefined, name: string) =>
  new Headers(init?.headers).get(name);

describe("forwardCloudRequest", () => {
  test("passes non-cloud requests through to static serving", async () => {
    const { calls, fetcher } = recorder();
    const response = await forwardCloudRequest({
      request: request("/assistant/assets/app.js"),
      cloudBase: PLATFORM,
      fetcher,
    });
    expect(response).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test("passes gateway requests through", async () => {
    const { calls, fetcher } = recorder();
    const response = await forwardCloudRequest({
      request: request("/__gateway/8080/v1/foo"),
      cloudBase: PLATFORM,
      fetcher,
    });
    expect(response).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test("does not forward paths that merely start with a prefix string", async () => {
    const { calls, fetcher } = recorder();
    expect(
      await forwardCloudRequest({
        request: request("/v1something/else"),
        cloudBase: PLATFORM,
        fetcher,
      }),
    ).toBeNull();
    expect(
      await forwardCloudRequest({
        request: request("/accountsettings"),
        cloudBase: PLATFORM,
        fetcher,
      }),
    ).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test("forwards /v1/* requests to the cloud", async () => {
    const { calls, fetcher } = recorder();
    const response = await forwardCloudRequest({
      request: request("/v1/assistants"),
      cloudBase: PLATFORM,
      fetcher,
    });
    expect(response?.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://cloud.mycadet.ai/v1/assistants");
    expect(calls[0]?.init.method).toBe("GET");
  });

  test("forwards /_allauth/* requests to the cloud", async () => {
    const { calls, fetcher } = recorder();
    await forwardCloudRequest({
      request: request("/_allauth/browser/v1/auth/session"),
      cloudBase: PLATFORM,
      fetcher,
    });
    expect(calls[0]?.url).toBe(
      "https://cloud.mycadet.ai/_allauth/browser/v1/auth/session",
    );
  });

  test("forwards /accounts/* requests to the cloud", async () => {
    const { calls, fetcher } = recorder();
    await forwardCloudRequest({
      request: request("/accounts/login"),
      cloudBase: PLATFORM,
      fetcher,
    });
    expect(calls[0]?.url).toBe("https://cloud.mycadet.ai/accounts/login");
  });

  test("forwards exact prefix without trailing slash", async () => {
    const { calls, fetcher } = recorder();
    await forwardCloudRequest({
      request: request("/v1"),
      cloudBase: PLATFORM,
      fetcher,
    });
    expect(calls[0]?.url).toBe("https://cloud.mycadet.ai/v1");
  });

  test("preserves query string on forwarded requests", async () => {
    const { calls, fetcher } = recorder();
    await forwardCloudRequest({
      request: request("/v1/assistants?page=2&limit=10"),
      cloudBase: PLATFORM,
      fetcher,
    });
    expect(calls[0]?.url).toBe(
      "https://cloud.mycadet.ai/v1/assistants?page=2&limit=10",
    );
  });

  test("forwards /v1/* to the gateway when one is set", async () => {
    const { calls, fetcher } = recorder();
    await forwardCloudRequest({
      request: request("/v1/assistants"),
      cloudBase: PLATFORM,
      gatewayBase: GATEWAY,
      fetcher,
    });
    expect(calls[0]?.url).toBe("http://127.0.0.1:20100/v1/assistants");
    expect(header(calls[0]?.init, "origin")).toBe("http://127.0.0.1:20100");
  });

  test("rides the cloud for /_allauth even when a gateway is set", async () => {
    const { calls, fetcher } = recorder();
    await forwardCloudRequest({
      request: request("/_allauth/browser/v1/auth/session"),
      cloudBase: PLATFORM,
      gatewayBase: GATEWAY,
      fetcher,
    });
    expect(calls[0]?.url).toBe(
      "https://cloud.mycadet.ai/_allauth/browser/v1/auth/session",
    );
    expect(header(calls[0]?.init, "origin")).toBe("https://cloud.mycadet.ai");
  });

  test("rides the cloud for /accounts even when a gateway is set", async () => {
    const { calls, fetcher } = recorder();
    await forwardCloudRequest({
      request: request("/accounts/login"),
      cloudBase: PLATFORM,
      gatewayBase: GATEWAY,
      fetcher,
    });
    expect(calls[0]?.url).toBe("https://cloud.mycadet.ai/accounts/login");
  });

  test("rides the cloud for /v1 when no gateway is set", async () => {
    const { calls, fetcher } = recorder();
    await forwardCloudRequest({
      request: request("/v1/assistants"),
      cloudBase: PLATFORM,
      fetcher,
    });
    expect(calls[0]?.url).toBe("https://cloud.mycadet.ai/v1/assistants");
  });

  test("rewrites Origin from app:// to the cloud origin", async () => {
    const { calls, fetcher } = recorder();
    await forwardCloudRequest({
      request: request("/v1/assistants", { origin: "app://mycadet.ai" }),
      cloudBase: PLATFORM,
      fetcher,
    });
    expect(header(calls[0]?.init, "origin")).toBe("https://cloud.mycadet.ai");
  });

  test("sets a cloud Origin even when the renderer sent none", async () => {
    const { calls, fetcher } = recorder();
    await forwardCloudRequest({
      request: request("/v1/assistants"),
      cloudBase: PLATFORM,
      fetcher,
    });
    expect(header(calls[0]?.init, "origin")).toBe("https://cloud.mycadet.ai");
  });

  test("forwards with manual redirects and omitted credentials", async () => {
    const { calls, fetcher } = recorder();
    await forwardCloudRequest({
      request: request("/v1/assistants"),
      cloudBase: PLATFORM,
      fetcher,
    });
    expect(calls[0]?.init.redirect).toBe("manual");
    expect(calls[0]?.init.credentials).toBe("omit");
  });

  test("forwards unsafe requests from the trusted app origin", async () => {
    const { calls, fetcher } = recorder();
    const response = await forwardCloudRequest({
      request: request("/_allauth/browser/v1/auth/session", {
        method: "POST",
        origin: "app://mycadet.ai",
      }),
      cloudBase: PLATFORM,
      fetcher,
      allowedOrigin,
    });
    expect(response?.status).toBe(200);
    expect(header(calls[0]?.init, "origin")).toBe("https://cloud.mycadet.ai");
  });

  test("rejects cloud requests with a foreign Origin", async () => {
    const { calls, fetcher } = recorder();
    const response = await forwardCloudRequest({
      request: request("/_allauth/browser/v1/auth/session", {
        method: "POST",
        origin: "https://evil.example",
      }),
      cloudBase: PLATFORM,
      fetcher,
      allowedOrigin,
    });
    expect(response?.status).toBe(403);
    expect(await response?.text()).toBe("Forbidden cloud proxy request");
    expect(calls).toHaveLength(0);
  });

  test("rejects cloud requests with a foreign Referer when Origin is absent", async () => {
    const { calls, fetcher } = recorder();
    const response = await forwardCloudRequest({
      request: request("/_allauth/browser/v1/auth/session", {
        method: "POST",
        headers: { referer: "https://evil.example/form" },
      }),
      cloudBase: PLATFORM,
      fetcher,
      allowedOrigin,
    });
    expect(response?.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  test("trusts source-less unsafe requests with renderer-origin marker", async () => {
    const { calls, fetcher } = recorder();
    await forwardCloudRequest({
      request: request("/v1/assistants", {
        method: "POST",
        headers: { [ELECTRON_RENDERER_ORIGIN_HEADER]: "app://mycadet.ai" },
      }),
      cloudBase: PLATFORM,
      fetcher,
      allowedOrigin,
    });
    expect(header(calls[0]?.init, "origin")).toBe("https://cloud.mycadet.ai");
    expect(header(calls[0]?.init, ELECTRON_RENDERER_ORIGIN_HEADER)).toBeNull();
  });

  test("trusts source-less unsafe requests with Sec-Fetch-Site same-origin", async () => {
    const { calls, fetcher } = recorder();
    const response = await forwardCloudRequest({
      request: request("/v1/assistants", {
        method: "POST",
        headers: { "sec-fetch-site": "same-origin" },
      }),
      cloudBase: PLATFORM,
      fetcher,
      allowedOrigin,
    });
    expect(response?.status).toBe(200);
  });

  test("rejects source-less unsafe requests with cross-site fetch metadata", async () => {
    const { calls, fetcher } = recorder();
    const response = await forwardCloudRequest({
      request: request("/v1/assistants", {
        method: "POST",
        headers: { "sec-fetch-site": "cross-site" },
      }),
      cloudBase: PLATFORM,
      fetcher,
      allowedOrigin,
    });
    expect(response?.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  test("rejects source-less unsafe requests without any trust signal", async () => {
    const { calls, fetcher } = recorder();
    const response = await forwardCloudRequest({
      request: request("/v1/assistants", { method: "POST" }),
      cloudBase: PLATFORM,
      fetcher,
      allowedOrigin,
    });
    expect(response?.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  test("rejects source-less unsafe requests from a foreign request URL", async () => {
    const { calls, fetcher } = recorder();
    const response = await forwardCloudRequest({
      request: {
        url: "app://evil.example/v1/assistants",
        method: "POST",
        headers: new Headers({
          [ELECTRON_RENDERER_ORIGIN_HEADER]: "app://mycadet.ai",
        }),
        body: null,
      },
      cloudBase: PLATFORM,
      fetcher,
      allowedOrigin,
    });
    expect(response?.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  test("forwards source-less safe cloud requests", async () => {
    const { calls, fetcher } = recorder();
    const response = await forwardCloudRequest({
      request: request("/v1/assistants", { method: "GET" }),
      cloudBase: PLATFORM,
      fetcher,
      allowedOrigin,
    });
    expect(response?.status).toBe(200);
  });

  test("preserves non-Origin headers", async () => {
    const { calls, fetcher } = recorder();
    await forwardCloudRequest({
      request: request("/_allauth/browser/v1/auth/session", {
        method: "POST",
        origin: "app://mycadet.ai",
        headers: {
          authorization: "Bearer api-token",
          "content-type": "application/json",
          "x-csrftoken": "csrf123",
        },
      }),
      cloudBase: PLATFORM,
      fetcher,
    });
    expect(header(calls[0]?.init, "authorization")).toBe("Bearer api-token");
    expect(header(calls[0]?.init, "content-type")).toBe("application/json");
    expect(header(calls[0]?.init, "x-csrftoken")).toBe("csrf123");
  });

  test("marks POST/PUT/PATCH/DELETE as having a body, GET/HEAD as none", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const { calls, fetcher } = recorder();
      await forwardCloudRequest({
        request: request("/v1/assistants", { method }),
        cloudBase: PLATFORM,
        fetcher,
      });
      expect(calls[0]?.init.body).toBeNull();
      expect(calls[0]?.init.duplex).toBe("half");
    }
    for (const method of ["GET", "HEAD"]) {
      const { calls, fetcher } = recorder();
      await forwardCloudRequest({
        request: request("/v1/assistants", { method }),
        cloudBase: PLATFORM,
        fetcher,
      });
      expect(calls[0]?.init.body).toBeUndefined();
      expect(calls[0]?.init.duplex).toBeUndefined();
    }
  });

  test("works with custom cloud URL (staging)", async () => {
    const { calls, fetcher } = recorder();
    await forwardCloudRequest({
      request: request("/v1/assistants"),
      cloudBase: "https://staging-cloud.mycadet.ai",
      fetcher,
    });
    expect(calls[0]?.url).toBe(
      "https://staging-cloud.mycadet.ai/v1/assistants",
    );
    expect(header(calls[0]?.init, "origin")).toBe(
      "https://staging-cloud.mycadet.ai",
    );
  });

  test("works with local cloud URL", async () => {
    const { calls, fetcher } = recorder();
    await forwardCloudRequest({
      request: request("/v1/assistants"),
      cloudBase: "http://localhost:8000",
      fetcher,
    });
    expect(calls[0]?.url).toBe("http://localhost:8000/v1/assistants");
    expect(header(calls[0]?.init, "origin")).toBe("http://localhost:8000");
  });

  test("reports failed attempts through log with module-owned wording", async () => {
    const { fetcher } = recorder();
    const errors: string[] = [];
    await forwardCloudRequest({
      request: request("/v1/assistants"),
      cloudBase: PLATFORM,
      fetcher: () => Promise.reject(new Error("boom")),
      log: { error: (...args) => errors.push(args.join(" ")) },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("[cloud-forward] fetch failed (attempt 1)");
    expect(errors[0]).toContain("GET https://cloud.mycadet.ai/v1/assistants");
  });

  test("transient net failures log as warnings, the rest as errors", async () => {
    const { fetcher } = recorder();
    const levels: string[] = [];
    const logger = {
      error: () => levels.push("error"),
      warning: () => levels.push("warning"),
    };
    await forwardCloudRequest({
      request: request("/v1/assistants"),
      cloudBase: PLATFORM,
      // Single attempt: the level-selection is the pin, not the retry count.
      retries: 0,
      fetcher: () => Promise.reject(new Error("net::ERR_NETWORK_CHANGED")),
      log: logger,
    });
    await forwardCloudRequest({
      request: request("/v1/assistants"),
      cloudBase: PLATFORM,
      fetcher: () => Promise.reject(new Error("boom")),
      log: logger,
    });
    expect(levels).toEqual(["warning", "error"]);
  });

  test("a warning-less logger logs transient failures as errors", async () => {
    const { fetcher } = recorder();
    const levels: string[] = [];
    await forwardCloudRequest({
      request: request("/v1/assistants"),
      cloudBase: PLATFORM,
      retries: 0,
      fetcher: () => Promise.reject(new Error("net::ERR_NETWORK_CHANGED")),
      log: { error: () => levels.push("error") },
    });
    expect(levels).toEqual(["error"]);
  });
});

  test("gateway-bound forwards carry the injected bearer, stripping any inbound one", async () => {
    const { calls, fetcher } = recorder();
    await forwardCloudRequest({
      request: request("/v1/assistants", {
        headers: { authorization: "Bearer stale-renderer-token" },
      }),
      cloudBase: PLATFORM,
      gatewayBase: GATEWAY,
      gatewayBearer: "guardian-token",
      fetcher,
    });
    expect(calls[0]?.url).toBe(`${GATEWAY}/v1/assistants`);
    expect(header(calls[0]?.init, "authorization")).toBe("Bearer guardian-token");
  });

  test("auth paths ride the cloud and never carry the gateway bearer", async () => {
    const { calls, fetcher } = recorder();
    await forwardCloudRequest({
      request: request("/_allauth/browser/v1/auth/session"),
      cloudBase: PLATFORM,
      gatewayBase: GATEWAY,
      gatewayBearer: "guardian-token",
      fetcher,
    });
    expect(calls[0]?.url).toBe(
      `${PLATFORM}/_allauth/browser/v1/auth/session`,
    );
    expect(header(calls[0]?.init, "authorization")).toBeNull();
  });

  test("gateway forwards without a bearer keep the inbound headers", async () => {
    const { calls, fetcher } = recorder();
    await forwardCloudRequest({
      request: request("/v1/assistants", {
        headers: { authorization: "Bearer renderer-supplied" },
      }),
      cloudBase: PLATFORM,
      gatewayBase: GATEWAY,
      fetcher,
    });
    expect(header(calls[0]?.init, "authorization")).toBe(
      "Bearer renderer-supplied",
    );
  });

// ---------------------------------------------------------------------------
// Transient-failure retry + structured proxy error (LUM-2402)
// ---------------------------------------------------------------------------

describe("isTransientNetworkError", () => {
  test("matches Chromium transient net errors", () => {
    for (const code of [
      "ERR_NETWORK_CHANGED",
      "ERR_INTERNET_DISCONNECTED",
      "ERR_NAME_NOT_RESOLVED",
      "ERR_CONNECTION_RESET",
    ]) {
      expect(isTransientNetworkError(new Error(`net::${code}`))).toBe(true);
    }
  });

  test("rejects other errors and non-Error values", () => {
    expect(isTransientNetworkError(new Error("net::ERR_CERT_INVALID"))).toBe(
      false,
    );
    expect(isTransientNetworkError(new Error("boom"))).toBe(false);
    expect(isTransientNetworkError("ERR_NETWORK_CHANGED")).toBe(false);
    expect(isTransientNetworkError(undefined)).toBe(false);
  });
});

describe("buildProxyNetworkErrorResponse", () => {
  test("returns a structured JSON 502 with the marker header", async () => {
    const response = buildProxyNetworkErrorResponse();
    expect(response.status).toBe(502);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get(PROXY_ERROR_HEADER)).toBe("network");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.code).toBe(PROXY_NETWORK_ERROR_CODE);
    expect(typeof body.detail).toBe("string");
    expect(body.detail).not.toContain("net::");
  });
});

describe("fetchForwardPlanWithRetry", () => {
  const noSleep = async () => {};
  const get = { method: "GET", hasBody: false };
  const post = { method: "POST", hasBody: true };

  test("retries a GET through a transient failure and returns the eventual success", async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const response = await fetchForwardPlanWithRetry(
      get,
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("net::ERR_NETWORK_CHANGED");
        return new Response("ok", { status: 200 });
      },
      {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );

    expect(response.status).toBe(200);
    expect(attempts).toBe(2);
    expect(sleeps).toEqual([500]);
  });

  test("returns the structured 502 after exhausting retries", async () => {
    let attempts = 0;
    const response = await fetchForwardPlanWithRetry(
      get,
      async () => {
        attempts += 1;
        throw new Error("net::ERR_NETWORK_CHANGED");
      },
      { retries: 2, sleep: noSleep },
    );

    expect(attempts).toBe(3);
    expect(response.status).toBe(502);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.code).toBe(PROXY_NETWORK_ERROR_CODE);
  });

  test("does not retry requests with a body — their stream is single-use", async () => {
    let attempts = 0;
    const response = await fetchForwardPlanWithRetry(
      post,
      async () => {
        attempts += 1;
        throw new Error("net::ERR_NETWORK_CHANGED");
      },
      { sleep: noSleep },
    );

    expect(attempts).toBe(1);
    expect(response.status).toBe(502);
  });

  test("does not retry non-transient failures", async () => {
    let attempts = 0;
    const response = await fetchForwardPlanWithRetry(
      get,
      async () => {
        attempts += 1;
        throw new Error("net::ERR_CERT_AUTHORITY_INVALID");
      },
      { sleep: noSleep },
    );

    expect(attempts).toBe(1);
    expect(response.status).toBe(502);
  });

  test("reports every failed attempt to onError", async () => {
    const seen: number[] = [];
    await fetchForwardPlanWithRetry(
      get,
      async () => {
        throw new Error("net::ERR_CONNECTION_RESET");
      },
      {
        retries: 1,
        sleep: noSleep,
        onError: (_err, attempt) => {
          seen.push(attempt);
        },
      },
    );

    expect(seen).toEqual([0, 1]);
  });

  test("a successful response passes through untouched on the first attempt", async () => {
    const upstream = new Response("hello", { status: 201 });
    const response = await fetchForwardPlanWithRetry(
      get,
      async () => upstream,
      {
        sleep: noSleep,
      },
    );
    expect(response).toBe(upstream);
  });
});
