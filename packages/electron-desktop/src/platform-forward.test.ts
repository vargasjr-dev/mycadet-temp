import { describe, expect, test } from "bun:test";

import {
  buildProxyNetworkErrorResponse,
  fetchForwardPlanWithRetry,
  isTransientNetworkError,
  planCloudForward,
  PROXY_ERROR_HEADER,
  PROXY_NETWORK_ERROR_CODE,
} from "./platform-forward";

const PLATFORM = "https://cloud.mycadet.ai";
const ELECTRON_RENDERER_ORIGIN_HEADER = "X-Cadet-Electron-Renderer-Origin";

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
});

describe("planCloudForward", () => {
  test("passes non-cloud requests through to static serving", () => {
    expect(
      planCloudForward(request("/assistant/assets/app.js"), PLATFORM),
    ).toEqual({ kind: "pass" });
  });

  test("passes gateway requests through", () => {
    expect(
      planCloudForward(request("/__gateway/8080/v1/foo"), PLATFORM),
    ).toEqual({ kind: "pass" });
  });

  test("forwards /v1/* requests to platform", () => {
    const plan = planCloudForward(request("/v1/assistants"), PLATFORM);
    expect(plan.kind).toBe("forward");
    if (plan.kind !== "forward") throw new Error("expected forward");
    expect(plan.url).toBe("https://cloud.mycadet.ai/v1/assistants");
    expect(plan.method).toBe("GET");
    expect(plan.hasBody).toBe(false);
  });

  test("forwards /_allauth/* requests to platform", () => {
    const plan = planCloudForward(
      request("/_allauth/browser/v1/auth/session"),
      PLATFORM,
    );
    if (plan.kind !== "forward") throw new Error("expected forward");
    expect(plan.url).toBe(
      "https://cloud.mycadet.ai/_allauth/browser/v1/auth/session",
    );
  });

  test("forwards /accounts/* requests to platform", () => {
    const plan = planCloudForward(request("/accounts/login"), PLATFORM);
    if (plan.kind !== "forward") throw new Error("expected forward");
    expect(plan.url).toBe("https://cloud.mycadet.ai/accounts/login");
  });

  test("forwards exact prefix without trailing slash", () => {
    const plan = planCloudForward(request("/v1"), PLATFORM);
    if (plan.kind !== "forward") throw new Error("expected forward");
    expect(plan.url).toBe("https://cloud.mycadet.ai/v1");
  });

  test("preserves query string on forwarded requests", () => {
    const plan = planCloudForward(
      request("/v1/assistants?page=2&limit=10"),
      PLATFORM,
    );
    if (plan.kind !== "forward") throw new Error("expected forward");
    expect(plan.url).toBe(
      "https://cloud.mycadet.ai/v1/assistants?page=2&limit=10",
    );
  });

  test("rewrites Origin from app:// to platform origin", () => {
    const plan = planCloudForward(
      request("/v1/assistants", { origin: "app://mycadet.ai" }),
      PLATFORM,
    );
    if (plan.kind !== "forward") throw new Error("expected forward");
    expect(plan.headers.get("origin")).toBe("https://cloud.mycadet.ai");
  });

  test("sets a cloud Origin even when the renderer sent none", () => {
    const plan = planCloudForward(request("/v1/assistants"), PLATFORM);
    if (plan.kind !== "forward") throw new Error("expected forward");
    expect(plan.headers.get("origin")).toBe("https://cloud.mycadet.ai");
  });

  test("forwards unsafe requests from the trusted app origin", () => {
    const plan = planCloudForward(
      request("/_allauth/browser/v1/auth/session", {
        method: "POST",
        origin: "app://mycadet.ai",
      }),
      PLATFORM,
      { allowedOrigin: { protocol: "app:", host: "mycadet.ai" } },
    );
    if (plan.kind !== "forward") throw new Error("expected forward");
    expect(plan.headers.get("origin")).toBe("https://cloud.mycadet.ai");
  });

  test("rejects platform requests with a foreign Origin", () => {
    const plan = planCloudForward(
      request("/_allauth/browser/v1/auth/session", {
        method: "POST",
        origin: "https://evil.example",
      }),
      PLATFORM,
      { allowedOrigin: { protocol: "app:", host: "mycadet.ai" } },
    );

    expect(plan).toEqual({
      kind: "reject",
      status: 403,
      message: "Forbidden cloud proxy request",
    });
  });

  test("rejects platform requests with a foreign Referer when Origin is absent", () => {
    const plan = planCloudForward(
      request("/_allauth/browser/v1/auth/session", {
        method: "POST",
        headers: { referer: "https://evil.example/form" },
      }),
      PLATFORM,
      { allowedOrigin: { protocol: "app:", host: "mycadet.ai" } },
    );

    expect(plan.kind).toBe("reject");
  });

  test("trusts source-less unsafe requests with renderer-origin marker", () => {
    const plan = planCloudForward(
      request("/v1/assistants", {
        method: "POST",
        headers: { [ELECTRON_RENDERER_ORIGIN_HEADER]: "app://mycadet.ai" },
      }),
      PLATFORM,
      { allowedOrigin: { protocol: "app:", host: "mycadet.ai" } },
    );

    if (plan.kind !== "forward") throw new Error("expected forward");
    expect(plan.headers.get("origin")).toBe("https://cloud.mycadet.ai");
    expect(plan.headers.get(ELECTRON_RENDERER_ORIGIN_HEADER)).toBeNull();
  });

  test("trusts source-less unsafe requests with Sec-Fetch-Site same-origin", () => {
    const plan = planCloudForward(
      request("/v1/assistants", {
        method: "POST",
        headers: { "sec-fetch-site": "same-origin" },
      }),
      PLATFORM,
      { allowedOrigin: { protocol: "app:", host: "mycadet.ai" } },
    );

    if (plan.kind !== "forward") throw new Error("expected forward");
  });

  test("rejects source-less unsafe requests with cross-site fetch metadata", () => {
    const plan = planCloudForward(
      request("/v1/assistants", {
        method: "POST",
        headers: { "sec-fetch-site": "cross-site" },
      }),
      PLATFORM,
      { allowedOrigin: { protocol: "app:", host: "mycadet.ai" } },
    );

    expect(plan.kind).toBe("reject");
  });

  test("rejects source-less unsafe requests without any trust signal", () => {
    const plan = planCloudForward(
      request("/v1/assistants", { method: "POST" }),
      PLATFORM,
      { allowedOrigin: { protocol: "app:", host: "mycadet.ai" } },
    );

    expect(plan.kind).toBe("reject");
  });

  test("rejects source-less unsafe requests from a foreign request URL", () => {
    const plan = planCloudForward(
      {
        url: "app://evil.example/v1/assistants",
        method: "POST",
        headers: new Headers({
          [ELECTRON_RENDERER_ORIGIN_HEADER]: "app://mycadet.ai",
        }),
      },
      PLATFORM,
      { allowedOrigin: { protocol: "app:", host: "mycadet.ai" } },
    );

    expect(plan.kind).toBe("reject");
  });

  test("forwards source-less safe platform requests", () => {
    const plan = planCloudForward(
      request("/v1/assistants", { method: "GET" }),
      PLATFORM,
      { allowedOrigin: { protocol: "app:", host: "mycadet.ai" } },
    );

    expect(plan.kind).toBe("forward");
  });

  test("preserves non-Origin headers", () => {
    const plan = planCloudForward(
      request("/_allauth/browser/v1/auth/session", {
        method: "POST",
        origin: "app://mycadet.ai",
        headers: {
          authorization: "Bearer api-token",
          "content-type": "application/json",
          "x-csrftoken": "csrf123",
        },
      }),
      PLATFORM,
    );
    if (plan.kind !== "forward") throw new Error("expected forward");
    expect(plan.headers.get("authorization")).toBe("Bearer api-token");
    expect(plan.headers.get("content-type")).toBe("application/json");
    expect(plan.headers.get("x-csrftoken")).toBe("csrf123");
  });

  test("marks POST/PUT/PATCH/DELETE as hasBody, GET/HEAD as no body", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const plan = planCloudForward(
        request("/v1/assistants", { method }),
        PLATFORM,
      );
      if (plan.kind !== "forward") throw new Error("expected forward");
      expect(plan.hasBody).toBe(true);
    }
    for (const method of ["GET", "HEAD"]) {
      const plan = planCloudForward(
        request("/v1/assistants", { method }),
        PLATFORM,
      );
      if (plan.kind !== "forward") throw new Error("expected forward");
      expect(plan.hasBody).toBe(false);
    }
  });

  test("works with custom platform URL (staging)", () => {
    const plan = planCloudForward(
      request("/v1/assistants"),
      "https://staging-cloud.mycadet.ai",
    );
    if (plan.kind !== "forward") throw new Error("expected forward");
    expect(plan.url).toBe("https://staging-cloud.mycadet.ai/v1/assistants");
    expect(plan.headers.get("origin")).toBe(
      "https://staging-cloud.mycadet.ai",
    );
  });

  test("works with local platform URL", () => {
    const plan = planCloudForward(
      request("/v1/assistants"),
      "http://localhost:8000",
    );
    if (plan.kind !== "forward") throw new Error("expected forward");
    expect(plan.url).toBe("http://localhost:8000/v1/assistants");
    expect(plan.headers.get("origin")).toBe("http://localhost:8000");
  });

  test("does not forward paths that merely start with a prefix string", () => {
    expect(planCloudForward(request("/v1something/else"), PLATFORM)).toEqual(
      { kind: "pass" },
    );

    expect(planCloudForward(request("/accountsettings"), PLATFORM)).toEqual({
      kind: "pass",
    });
  });
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
