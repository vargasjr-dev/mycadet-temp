import { describe, expect, test } from "bun:test";
import { describeError } from "./describe-error";

describe("describeError", () => {
  test("an Error renders its message (and stack) instead of {}", () => {
    const rendered = describeError(new Error("the daemon is down"));
    expect(rendered).toContain("the daemon is down");
    expect(rendered).not.toBe("{}");
  });

  test("an Error without a stack falls back to name and message", () => {
    const error = new TypeError("no dial tone");
    error.stack = undefined;
    expect(describeError(error)).toBe("TypeError: no dial tone");
  });

  test("a string passes through", () => {
    expect(describeError("plain")).toBe("plain");
  });

  test("anything else renders as JSON", () => {
    expect(describeError({ status: 502 })).toBe('{"status":502}');
  });
});
