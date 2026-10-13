import { describe, expect, test } from "bun:test";
import { normalizeToError } from "@app/lib/error-reporting/normalize-error";

describe("normalizeToError", () => {
  test("returns Error instances unchanged", () => {
    const err = new Error("original");
    expect(normalizeToError(err)).toBe(err);
  });

  test("wraps object with `detail` string", () => {
    const raw = { detail: "Your assistant is still starting up." };
    const result = normalizeToError(raw);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe("Your assistant is still starting up.");
    expect(result.cause).toBe(raw);
  });

  test("wraps object with `message` string", () => {
    const raw = { message: "Something went wrong", code: 500 };
    const result = normalizeToError(raw);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe("Something went wrong");
    expect(result.cause).toBe(raw);
  });

  test("prefers `detail` over `message` when both are present", () => {
    const raw = { detail: "detail wins", message: "message loses" };
    const result = normalizeToError(raw);
    expect(result.message).toBe("detail wins");
  });

  test("falls back to JSON.stringify for unknown object shapes", () => {
    const raw = { code: 503, status: "unavailable" };
    const result = normalizeToError(raw);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe(JSON.stringify(raw));
    expect(result.cause).toBe(raw);
  });

  test("handles non-serializable objects", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const result = normalizeToError(circular);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe("Non-serializable error object");
    expect(result.cause).toBe(circular);
  });

  test("wraps string values", () => {
    const result = normalizeToError("string error");
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe("string error");
  });

  test("wraps null", () => {
    const result = normalizeToError(null);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe("null");
  });

  test("wraps undefined", () => {
    const result = normalizeToError(undefined);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toBe("undefined");
  });
});
