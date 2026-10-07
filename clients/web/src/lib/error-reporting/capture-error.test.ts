import { describe, expect, mock, test } from "bun:test";

const consoleErrorMock = mock((..._args: unknown[]) => {});
const consoleWarnMock = mock((..._args: unknown[]) => {});
console.error = consoleErrorMock as unknown as typeof console.error;
console.warn = consoleWarnMock as unknown as typeof console.warn;

const { captureError, normalizeToError, isExpectedDaemonTransientError } =
  await import("@/lib/error-reporting/capture-error");
const { ApiError } = await import("@/utils/api-errors");
const { CancelledError } = await import("@tanstack/react-query");

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

describe("captureError", () => {
  test("reports normalized Error with originalError extra detail", () => {
    consoleErrorMock.mockClear();
    const raw = { detail: "still starting up" };
    captureError(raw, { context: "test-ctx" });

    expect(consoleErrorMock).toHaveBeenCalledTimes(1);
    const [label, reported, detail] = consoleErrorMock.mock.calls[0]!;
    expect(label).toBe("[test-ctx]");
    expect(reported).toBeInstanceOf(Error);
    expect((reported as Error).message).toBe("still starting up");
    expect(
      (detail as Record<string, unknown>).extra,
    ).toMatchObject({ originalError: raw });
  });

  test("reports Error instances directly without extra detail", () => {
    consoleErrorMock.mockClear();
    const err = new Error("real error");
    captureError(err, { context: "test-ctx" });

    expect(consoleErrorMock).toHaveBeenCalledTimes(1);
    const [, reported, detail] = consoleErrorMock.mock.calls[0]!;
    expect(reported).toBe(err);
    expect(detail).toBe("");
  });

  test("silently drops transient network errors", () => {
    consoleErrorMock.mockClear();
    captureError(new TypeError("Failed to fetch"), { context: "test-ctx" });
    expect(consoleErrorMock).not.toHaveBeenCalled();
  });

  test("silently drops TanStack Query cancellations", () => {
    consoleErrorMock.mockClear();
    captureError(new CancelledError({ revert: true }), { context: "test-ctx" });
    expect(consoleErrorMock).not.toHaveBeenCalled();
  });

  test("silently drops fetch aborts", () => {
    consoleErrorMock.mockClear();
    captureError(
      new DOMException("signal is aborted without reason", "AbortError"),
      { context: "test-ctx" },
    );
    expect(consoleErrorMock).not.toHaveBeenCalled();
  });

  test("reports daemon transient errors without bestEffort flag", () => {
    consoleErrorMock.mockClear();
    captureError(new ApiError(503, "Your assistant is still starting up."), {
      context: "test-ctx",
    });
    expect(consoleErrorMock).toHaveBeenCalledTimes(1);
  });

  test("silently drops daemon transient errors with bestEffort flag", () => {
    consoleErrorMock.mockClear();
    captureError(new ApiError(503, "Your assistant is still starting up."), {
      context: "test-ctx",
      bestEffort: true,
    });
    expect(consoleErrorMock).not.toHaveBeenCalled();
  });

  test("reports unexpected ApiError even with bestEffort flag", () => {
    consoleErrorMock.mockClear();
    captureError(new ApiError(500, "Internal Server Error"), {
      context: "test-ctx",
      bestEffort: true,
    });
    expect(consoleErrorMock).toHaveBeenCalledTimes(1);
  });

  test("routes warning and info levels to console.warn with tags", () => {
    consoleErrorMock.mockClear();
    consoleWarnMock.mockClear();
    captureError(new Error("degraded"), {
      context: "test-ctx",
      level: "warning",
      tags: { boundary: "lazy-component" },
    });
    expect(consoleWarnMock).toHaveBeenCalledTimes(1);
    expect(consoleErrorMock).not.toHaveBeenCalled();
    const [label, , detail] = consoleWarnMock.mock.calls[0]!;
    expect(label).toBe("[test-ctx]");
    expect((detail as Record<string, unknown>).tags).toEqual({
      boundary: "lazy-component",
    });
  });
});

describe("isExpectedDaemonTransientError", () => {
  test("returns true for 503 daemon starting up", () => {
    expect(
      isExpectedDaemonTransientError(
        new ApiError(503, "Your assistant is still starting up."),
      ),
    ).toBe(true);
  });

  test("returns true for 502 bad gateway", () => {
    expect(
      isExpectedDaemonTransientError(new ApiError(502, "Bad gateway")),
    ).toBe(true);
  });

  test("returns true for 401 auth race", () => {
    expect(
      isExpectedDaemonTransientError(
        new ApiError(401, "Authentication credentials were not provided."),
      ),
    ).toBe(true);
  });

  test("returns true for 400 org-header missing", () => {
    expect(
      isExpectedDaemonTransientError(
        new ApiError(400, "Cadet-Organization-Id header is required."),
      ),
    ).toBe(true);
  });

  test("returns false for 400 without org-header message", () => {
    expect(
      isExpectedDaemonTransientError(
        new ApiError(400, "Invalid request body."),
      ),
    ).toBe(false);
  });

  test("returns false for 500 internal server error", () => {
    expect(
      isExpectedDaemonTransientError(
        new ApiError(500, "Internal Server Error"),
      ),
    ).toBe(false);
  });

  test("returns false for non-ApiError instances", () => {
    expect(isExpectedDaemonTransientError(new Error("random error"))).toBe(
      false,
    );
    expect(
      isExpectedDaemonTransientError(new TypeError("Failed to fetch")),
    ).toBe(false);
    expect(isExpectedDaemonTransientError("string error")).toBe(false);
    expect(isExpectedDaemonTransientError(null)).toBe(false);
  });
});
