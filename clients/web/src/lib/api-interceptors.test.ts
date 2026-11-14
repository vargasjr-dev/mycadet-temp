/**
 * Unit tests for the HeyAPI client request interceptor.
 *
 * Pins the ATL-703 header contract: every outbound request — regardless of
 * method — must carry `X-Cadet-Client-Id` + `X-Cadet-Interface-Id` so the
 * daemon can echo the originator id back on `sync_changed` and the hub can
 * suppress the SSE echo to that subscriber.
 *
 * The test calls `daemonRequestInterceptor` directly instead of round-tripping
 * through the HeyAPI client. That way we don't depend on any private
 * interceptor-list internals; if the interceptor function gets the inputs
 * right, the registrations at the bottom of the module do the rest.
 */

import {
  afterEach,
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
  daemonErrorInterceptor,
  daemonRequestInterceptor,
} from "@/lib/api-interceptors";

import { ApiError } from "@/utils/api-errors";
import { getClientId } from "@/lib/client-identity";

const ELECTRON_RENDERER_ORIGIN_HEADER = "X-Cadet-Electron-Renderer-Origin";

async function intercept(
  method: string,
  url = "https://example.test/v1/probe",
) {
  const request = new Request(url, { method });
  const result = await daemonRequestInterceptor(request);
  return result.headers;
}

describe("api-interceptors / daemonRequestInterceptor", () => {
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

  test("does not attach renderer-origin marker outside Electron", async () => {
    const headers = await intercept("POST");
    expect(headers.get(ELECTRON_RENDERER_ORIGIN_HEADER)).toBeNull();
  });

  test("returns a new Request, leaving the input headers untouched", async () => {
    const input = new Request("https://example.test/v1/probe", {
      method: "POST",
    });
    expect(input.headers.get("X-Cadet-Client-Id")).toBeNull();

    const output = await daemonRequestInterceptor(input);
    expect(output).not.toBe(input);
    expect(input.headers.get("X-Cadet-Client-Id")).toBeNull();
    expect(output.headers.get("X-Cadet-Client-Id")).toBe(getClientId());
  });
});

describe("api-interceptors / Electron renderer-origin marker", () => {
  beforeEach(() => {
    (window as unknown as { cadet?: unknown }).cadet = {
      platform: "electron",
    };
  });

  afterEach(() => {
    delete (window as unknown as { cadet?: unknown }).cadet;
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
