import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  forwardOperatorRequest,
  type OperatorRequest,
} from "../operations/routes";
import {
  buildProxyNetworkErrorResponse,
  forwardCloudRequest,
  isTransientNetworkError,
  PROXY_ERROR_HEADER,
  PROXY_NETWORK_ERROR_CODE,
} from "../operations/cloud-forward";

const CLOUD = "https://cloud.mycadet.ai";

/** A mount request, shaped the way the serving hosts hand the dispatcher. */
const request = (
  pathname: string,
  init: {
    method?: string;
    origin?: string;
    headers?: Record<string, string>;
  } = {},
) =>
  new Request(`app://mycadet.ai${pathname}`, {
    method: init.method ?? "GET",
    headers: new Headers({
      ...(init.origin !== undefined ? { origin: init.origin } : {}),
      ...init.headers,
    }),
    body: null,
  });

/** An operator request, shaped the way the dispatcher hands the arm's row. */
const armRequest = (
  path: string,
  init: { method?: string; headers?: Record<string, string> } = {},
): OperatorRequest => ({
  assistant: null,
  method: (init.method ?? "GET") as OperatorRequest["method"],
  path,
  headers: new Headers(init.headers),
  body: null,
  signal: null,
});

const REAL_FETCH = globalThis.fetch;
let calls: Array<{ url: string; init: RequestInit | undefined }> = [];

/**
 * Stubs the ambient fetch (the arm's only dial) — by default it records
 * what the arm would have sent and answers "forwarded".
 */
const stubFetch = (
  impl?: (url: string, init?: RequestInit) => Promise<Response>,
): void => {
  globalThis.fetch = (async (url: unknown, init?: RequestInit) =>
    impl
      ? impl(String(url), init)
      : (calls.push({ url: String(url), init }),
        new Response("forwarded", { status: 200 }))) as typeof fetch;
};

const header = (init: RequestInit | undefined, name: string) =>
  new Headers(init?.headers).get(name);

/** Dispatches through the real dispatcher — the arm's dial is stubbed. */
const dispatch = (req: Request): Promise<Response | null> =>
  forwardOperatorRequest(req);

// The arm resolves its target through getCloudBaseUrl at request time —
// pin it to the cloud base for every test (the afterEach restores the
// ambient env; the staging/local cases overwrite it explicitly).
const SAVED_CLOUD_URL = process.env.CADET_CLOUD_URL;
beforeEach(() => {
  calls = [];
  process.env.CADET_CLOUD_URL = CLOUD;
  stubFetch();
});
afterEach(() => {
  globalThis.fetch = REAL_FETCH;
  if (SAVED_CLOUD_URL === undefined) {
    delete process.env.CADET_CLOUD_URL;
  } else {
    process.env.CADET_CLOUD_URL = SAVED_CLOUD_URL;
  }
});

describe("the operator's cloud arm", () => {
  test("passes non-cloud requests through to the host chain", async () => {
    expect(await dispatch(request("/assistant/assets/app.js"))).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test("passes gateway requests through", async () => {
    expect(await dispatch(request("/__gateway/8080/v1/foo"))).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test("does not forward paths that merely start with a prefix string", async () => {
    expect(await dispatch(request("/_allauthx/none"))).toBeNull();
    expect(await dispatch(request("/accountsettings"))).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test("forwards the releases catalog; the bare /v1 rides the host chain", async () => {
    // The catalog is the cloud's own read — the caller's auth rides the
    // forward. The bare /v1 is nobody's path here; the host chain answers.
    expect(await dispatch(request("/v1/releases/"))).not.toBeNull();
    expect(await dispatch(request("/v1"))).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://cloud.mycadet.ai/v1/releases/");
  });

  test("a scoped request for an unknown id answers 404 from the dispatcher", async () => {
    // The catch-all matches the stale id, but the dispatcher refuses to
    // pass an id it cannot resolve — no row run, no arm dial.
    const response = await dispatch(
      request("/v1/assistants/ghost/conversations"),
    );
    expect(response?.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  test("forwards /_allauth/* requests to the cloud", async () => {
    const response = await dispatch(
      request("/_allauth/browser/v1/auth/session"),
    );
    expect(response?.status).toBe(200);
    expect(calls[0]?.url).toBe(
      "https://cloud.mycadet.ai/_allauth/browser/v1/auth/session",
    );
    expect(calls[0]?.init?.method).toBe("GET");
  });

  test("forwards /accounts/* requests to the cloud", async () => {
    await dispatch(request("/accounts/login"));
    expect(calls[0]?.url).toBe("https://cloud.mycadet.ai/accounts/login");
  });

  test("forwards the exact account prefixes without a trailing slash", async () => {
    await dispatch(request("/_allauth"));
    expect(calls[0]?.url).toBe("https://cloud.mycadet.ai/_allauth");
  });

  test("preserves query string on forwarded requests", async () => {
    await dispatch(request("/accounts/login?next=/dashboard"));
    expect(calls[0]?.url).toBe(
      "https://cloud.mycadet.ai/accounts/login?next=/dashboard",
    );
  });

  test("rewrites Origin from app:// to the cloud origin", async () => {
    await dispatch(
      request("/_allauth/browser/v1/auth/session", {
        method: "POST",
        origin: "app://mycadet.ai",
      }),
    );
    expect(header(calls[0]?.init, "origin")).toBe("https://cloud.mycadet.ai");
  });

  test("sets a cloud Origin even when the renderer sent none", async () => {
    await dispatch(request("/_allauth/browser/v1/config"));
    expect(header(calls[0]?.init, "origin")).toBe("https://cloud.mycadet.ai");
  });

  test("forwards with manual redirects and the ambient credentials mode", async () => {
    await dispatch(request("/_allauth/browser/v1/config"));
    expect(calls[0]?.init?.redirect).toBe("manual");
    expect(calls[0]?.init?.credentials).toBeUndefined();
  });

  test("forwards unsafe requests from the app origin", async () => {
    const response = await dispatch(
      request("/_allauth/browser/v1/auth/session", {
        method: "POST",
        origin: "app://mycadet.ai",
      }),
    );
    expect(response?.status).toBe(200);
    expect(header(calls[0]?.init, "origin")).toBe("https://cloud.mycadet.ai");
  });

  test("preserves non-Origin headers", async () => {
    await dispatch(
      request("/_allauth/browser/v1/auth/session", {
        method: "POST",
        origin: "app://mycadet.ai",
        headers: {
          authorization: "Bearer api-token",
          "content-type": "application/json",
          "x-csrftoken": "csrf123",
        },
      }),
    );
    expect(header(calls[0]?.init, "authorization")).toBe("Bearer api-token");
    expect(header(calls[0]?.init, "content-type")).toBe("application/json");
    expect(header(calls[0]?.init, "x-csrftoken")).toBe("csrf123");
  });

  test("marks POST/PUT/PATCH/DELETE as having a body, GET/HEAD as none", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      await dispatch(
        request("/_allauth/app/v1/auth/sessions", {
          method,
          origin: "app://mycadet.ai",
        }),
      );
      expect(calls[0]?.init?.body).toBeNull();
      expect((calls[0]?.init as { duplex?: unknown } | undefined)?.duplex).toBe(
        "half",
      );
      calls = [];
    }
    for (const method of ["GET", "HEAD"]) {
      await dispatch(request("/_allauth/app/v1/auth/sessions", { method }));
      expect(calls[0]?.init?.body).toBeUndefined();
      expect(
        (calls[0]?.init as { duplex?: unknown } | undefined)?.duplex,
      ).toBeUndefined();
      calls = [];
    }
  });

  test("resolves the target through the same CADET_CLOUD_URL override (staging)", async () => {
    process.env.CADET_CLOUD_URL = "https://staging-cloud.mycadet.ai";
    await dispatch(request("/_allauth/browser/v1/config"));
    expect(calls[0]?.url).toBe(
      "https://staging-cloud.mycadet.ai/_allauth/browser/v1/config",
    );
    expect(header(calls[0]?.init, "origin")).toBe(
      "https://staging-cloud.mycadet.ai",
    );
  });

  test("resolves the target through a local cloud URL override", async () => {
    process.env.CADET_CLOUD_URL = "http://localhost:8000";
    await dispatch(request("/_allauth/browser/v1/config"));
    expect(calls[0]?.url).toBe(
      "http://localhost:8000/_allauth/browser/v1/config",
    );
    expect(header(calls[0]?.init, "origin")).toBe("http://localhost:8000");
  });

  test("a row's answer wins over the arm", async () => {
    // The assistants list row owns this path; the arm never dials.
    const response = await dispatch(request("/v1/assistants"));
    expect(await response?.text()).not.toBe("forwarded");
    expect(calls).toHaveLength(0);
  });

  test("reports failed attempts through console with module-owned wording", async () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    stubFetch(() => Promise.reject(new Error("boom")));
    try {
      await forwardCloudRequest(armRequest("/_allauth/browser/v1/config"));
    } finally {
      console.error = original;
    }
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("[cloud-forward] fetch failed (attempt 1)");
    expect(errors[0]).toContain(
      "GET https://cloud.mycadet.ai/_allauth/browser/v1/config",
    );
  });

  test("transient net failures log as warnings, the rest as errors", async () => {
    const levels: string[] = [];
    const originalWarn = console.warn;
    const originalError = console.error;
    console.warn = () => levels.push("warning");
    console.error = () => levels.push("error");
    try {
      // DELETE never retries — one attempt each, so the level selection
      // is the pin, not the retry count.
      stubFetch(() => Promise.reject(new Error("net::ERR_NETWORK_CHANGED")));
      await forwardCloudRequest(
        armRequest("/_allauth/app/v1/auth/sessions", { method: "DELETE" }),
      );
      stubFetch(() => Promise.reject(new Error("boom")));
      await forwardCloudRequest(
        armRequest("/_allauth/app/v1/auth/sessions", { method: "DELETE" }),
      );
    } finally {
      console.warn = originalWarn;
      console.error = originalError;
    }
    expect(levels).toEqual(["warning", "error"]);
  });
});

describe("the arm's transient-failure retry", () => {
  test("retries a GET through a transient failure and returns the eventual success", async () => {
    let attempts = 0;
    stubFetch(() => {
      attempts += 1;
      if (attempts === 1) throw new Error("net::ERR_NETWORK_CHANGED");
      return Promise.resolve(new Response("forwarded", { status: 200 }));
    });
    const response = await forwardCloudRequest(
      armRequest("/_allauth/browser/v1/config"),
    );
    expect(response?.status).toBe(200);
    expect(attempts).toBe(2);
  });

  test("returns the structured 502 after exhausting retries", async () => {
    let attempts = 0;
    stubFetch(() => {
      attempts += 1;
      return Promise.reject(new Error("net::ERR_NETWORK_CHANGED"));
    });
    const response = await forwardCloudRequest(
      armRequest("/_allauth/browser/v1/config"),
    );
    expect(attempts).toBe(3);
    expect(response?.status).toBe(502);
    const body = (await response?.json()) as Record<string, unknown>;
    expect(body.code).toBe(PROXY_NETWORK_ERROR_CODE);
  });

  test("does not retry requests with a body — their stream is single-use", async () => {
    let attempts = 0;
    stubFetch(() => {
      attempts += 1;
      return Promise.reject(new Error("net::ERR_NETWORK_CHANGED"));
    });
    const response = await forwardCloudRequest(
      armRequest("/_allauth/browser/v1/auth/session", { method: "POST" }),
    );
    expect(attempts).toBe(1);
    expect(response?.status).toBe(502);
  });

  test("does not retry non-transient failures", async () => {
    let attempts = 0;
    stubFetch(() => {
      attempts += 1;
      return Promise.reject(new Error("net::ERR_CERT_AUTHORITY_INVALID"));
    });
    const response = await forwardCloudRequest(
      armRequest("/_allauth/browser/v1/config"),
    );
    expect(attempts).toBe(1);
    expect(response?.status).toBe(502);
  });

  test("a successful response passes through untouched on the first attempt", async () => {
    const upstream = new Response("hello", { status: 201 });
    stubFetch(() => Promise.resolve(upstream));
    const response = await forwardCloudRequest(
      armRequest("/_allauth/browser/v1/config"),
    );
    expect(response).toBe(upstream);
  });
});

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
