import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import { CancelledError } from "@tanstack/react-query";
import { captureError } from "./capture-error";

const errors = spyOn(console, "error").mockImplementation(() => {});
const warnings = spyOn(console, "warn").mockImplementation(() => {});
beforeEach(() => {
  errors.mockClear();
  warnings.mockClear();
});
afterAll(() => {
  errors.mockRestore();
  warnings.mockRestore();
});

test("expected network failures and intentional cancellations do not report", () => {
  for (const error of [
    new TypeError("Failed to fetch"),
    new CancelledError(),
    new DOMException("cancelled", "AbortError"),
  ]) {
    captureError(error, { context: "account" });
  }
  expect(errors).not.toHaveBeenCalled();
  expect(warnings).not.toHaveBeenCalled();
});

test("account failures normalize API bodies and preserve context", () => {
  const original = { detail: "Sign-in refused" };
  captureError(original, {
    context: "provider_callback",
    tags: { authError: "login_incomplete" },
  });
  expect(errors).toHaveBeenCalledTimes(1);
  const [context, normalized, metadata] = errors.mock.calls[0]!;
  expect(context).toBe("[provider_callback]");
  expect(normalized).toBeInstanceOf(Error);
  expect((normalized as Error).message).toBe("Sign-in refused");
  expect(metadata).toEqual({
    tags: { authError: "login_incomplete" },
    extra: { originalError: original },
  });
});

test("warnings use the warning channel and retain the original Error", () => {
  const error = new Error("Account lookup failed");
  captureError(error, { context: "account", level: "warning" });
  expect(warnings).toHaveBeenCalledWith("[account]", error, "");
  expect(errors).not.toHaveBeenCalled();
});
