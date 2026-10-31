/**
 * Unit tests for the resolution query's cache-key policy.
 *
 * The selection-suffixed key died with the selection: the web bundle is
 * always focused on ONE assistant, so the resolution is a single shared
 * cache entry.
 */

import { describe, expect, test } from "bun:test";

const { ASSISTANT_QUERY_KEY } = await import("@/assistant/queries");

describe("ASSISTANT_QUERY_KEY", () => {
  test("is one constant key — there is no selection to suffix", () => {
    expect(ASSISTANT_QUERY_KEY).toEqual(["assistant", "current"]);
  });
});
