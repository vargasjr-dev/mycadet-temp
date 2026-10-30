/**
 * Unit tests for the resolution query's cache-key policy.
 *
 * The polling-cadence policy died with `AssistantResolutionState`: the web
 * bundle exists only for a resolved assistant, so there is no transient
 * phase to poll through.
 */

import { describe, expect, test } from "bun:test";

const { ASSISTANT_QUERY_KEY, assistantQueryKey } = await import(
  "@/assistant/queries"
);

describe("assistantQueryKey", () => {
  test("returns the base key by reference when nothing is selected (off-path is byte-identical)", () => {
    // Same reference, not just a deep-equal copy — so every existing
    // setQueryData / invalidate site that uses ASSISTANT_QUERY_KEY keeps
    // matching when multi-assistant is off.
    expect(assistantQueryKey()).toBe(ASSISTANT_QUERY_KEY);
    expect(assistantQueryKey(null)).toBe(ASSISTANT_QUERY_KEY);
  });

  test("suffixes the selected id so a switch is a distinct cache key", () => {
    expect(assistantQueryKey("ast-2")).toEqual([
      ...ASSISTANT_QUERY_KEY,
      "ast-2",
    ]);
    expect(assistantQueryKey("ast-2")).not.toBe(ASSISTANT_QUERY_KEY);
    expect(assistantQueryKey("ast-2")).not.toEqual(assistantQueryKey("ast-3"));
  });
});
