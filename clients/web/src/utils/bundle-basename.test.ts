import { describe, expect, test } from "bun:test";

import { bundleBasename } from "./bundle-basename";

describe("bundleBasename", () => {
  test("no basename for the root-served desktop mount", () => {
    // The desktop's app:// handler serves the web bundle at /assistant/*
    // and the route tree spells its paths /assistant/* — index 0 means
    // root-served as far as the router is concerned.
    expect(bundleBasename(new URL("app://mycadet.ai/assistant/about"))).toBe(
      undefined,
    );
    expect(
      bundleBasename(new URL("app://mycadet.ai/assistant/conversations/c1")),
    ).toBe(undefined);
  });

  test("no basename for a root-served dev server", () => {
    expect(
      bundleBasename(new URL("http://localhost:5173/assistant/about")),
    ).toBe(undefined);
  });

  test("the versioned artifact prefix becomes the basename", () => {
    expect(
      bundleBasename(
        new URL("https://mycadet.ai/web/abc123/assistant/conversations/c1"),
      ),
    ).toBe("/web/abc123");
  });

  test("a tenant-prefixed mount keeps only the prefix before /assistant", () => {
    // The /assistant-123 spelling must not match the mount regex itself —
    // the prefix is whatever sits before the REAL /assistant segment.
    expect(
      bundleBasename(
        new URL("https://mycadet.ai/assistant-123/assistant/pair"),
      ),
    ).toBe("/assistant-123");
  });

  test("trailing slashes on the prefix are trimmed", () => {
    expect(
      bundleBasename(new URL("https://mycadet.ai/web/abc123//assistant/pair")),
    ).toBe("/web/abc123");
  });

  test("no /assistant segment at all means no basename", () => {
    expect(bundleBasename(new URL("https://mycadet.ai/"))).toBe(undefined);
  });
});
