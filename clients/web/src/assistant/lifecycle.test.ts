import { describe, expect, test } from "bun:test";

import {
  assistantStateCanServeChat,
  isTransportShapedError,
  PROXY_NETWORK_ERROR_CODE,
  resolveAssistantLifecycleState,
  TRANSPORT_ERROR_MESSAGE,
} from "./lifecycle";

describe("assistantStateCanServeChat", () => {
  test("active serves chat", () => {
    expect(assistantStateCanServeChat("active")).toBe(true);
  });

  test("self_hosted serves chat — the daemon is the runtime", () => {
    expect(assistantStateCanServeChat("self_hosted")).toBe(true);
  });

  test("every other kind is not serving chat", () => {
    expect(assistantStateCanServeChat("loading")).toBe(false);
    expect(assistantStateCanServeChat("initializing")).toBe(false);
    expect(assistantStateCanServeChat("cleaning_up")).toBe(false);
    expect(assistantStateCanServeChat("error")).toBe(false);
  });
});

describe("resolveAssistantLifecycleState — transport-shaped failures (LUM-2402)", () => {
  test("proxy-synthesized network 502 resolves to a transient error with friendly copy", () => {
    expect(
      resolveAssistantLifecycleState({
        ok: false,
        status: 502,
        error: {
          detail: "Couldn't reach Cadet.",
          code: PROXY_NETWORK_ERROR_CODE,
        },
      }),
    ).toEqual({
      kind: "error",
      transient: true,
      message: TRANSPORT_ERROR_MESSAGE,
    });
  });

  test("raw Chromium net:: detail (legacy proxy body) is never shown to the user", () => {
    const state = resolveAssistantLifecycleState({
      ok: false,
      status: 502,
      error: { detail: "net::ERR_NETWORK_CHANGED" },
    });
    expect(state).toEqual({
      kind: "error",
      transient: true,
      message: TRANSPORT_ERROR_MESSAGE,
    });
  });

  test("genuine server errors stay non-transient with their own message", () => {
    expect(
      resolveAssistantLifecycleState({
        ok: false,
        status: 500,
        error: { detail: "Internal server error" },
      }),
    ).toEqual({ kind: "error", message: "Internal server error" });
  });

  test("404 still resolves to auto_hatch, not a transport error", () => {
    expect(
      resolveAssistantLifecycleState({ ok: false, status: 404, error: {} }),
    ).toEqual({ kind: "auto_hatch" });
  });
});

describe("isTransportShapedError", () => {
  test("matches the structured proxy code", () => {
    expect(isTransportShapedError({ code: PROXY_NETWORK_ERROR_CODE })).toBe(
      true,
    );
  });

  test("matches a raw net::ERR_* detail", () => {
    expect(
      isTransportShapedError({ detail: "net::ERR_INTERNET_DISCONNECTED" }),
    ).toBe(true);
  });

  test("does not match ordinary server error payloads", () => {
    expect(isTransportShapedError({ detail: "Bad Gateway" })).toBe(false);
    expect(isTransportShapedError({ code: "platform_hosted_disabled" })).toBe(
      false,
    );
    expect(isTransportShapedError({})).toBe(false);
  });
});

