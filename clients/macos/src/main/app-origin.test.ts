import { describe, expect, test } from "bun:test";

import { isAllowedOrigin, resolveAllowedOrigin } from "./app-origin";

describe("resolveAllowedOrigin", () => {
  test("resolves the app://mycadet.ai tuple origin in every build", () => {
    // `bun run dev` packs the renderer dists and serves them through the
    // same `app://` protocol handler as packaged builds, so there is no
    // dev branch — the origin is a constant.
    expect(resolveAllowedOrigin()).toEqual({
      protocol: "app:",
      host: "mycadet.ai",
    });
  });
});

describe("isAllowedOrigin", () => {
  const prod = { protocol: "app:", host: "mycadet.ai" };
  const dev = { protocol: "http:", host: "localhost:5173" };

  test("accepts the exact packaged origin string a frame reports", () => {
    expect(isAllowedOrigin("app://mycadet.ai", prod)).toBe(true);
  });

  test("accepts an already-parsed URL navigation target", () => {
    expect(
      isAllowedOrigin(new URL("http://localhost:5173/assistant"), dev),
    ).toBe(true);
  });

  test("rejects a foreign host on the right protocol", () => {
    expect(isAllowedOrigin("https://evil.example.com", prod)).toBe(false);
    expect(isAllowedOrigin("http://localhost:9999", dev)).toBe(false);
  });

  test("rejects a protocol mismatch on the right host", () => {
    expect(isAllowedOrigin("https://mycadet.ai", prod)).toBe(false);
  });

  test("rejects null, undefined, empty, and unparseable origins", () => {
    expect(isAllowedOrigin(null, prod)).toBe(false);
    expect(isAllowedOrigin(undefined, prod)).toBe(false);
    expect(isAllowedOrigin("", prod)).toBe(false);
    expect(isAllowedOrigin("not a url", prod)).toBe(false);
  });

  test("rejects the opaque 'null' origin a sandboxed/foreign frame reports", () => {
    expect(isAllowedOrigin("null", prod)).toBe(false);
  });
});
