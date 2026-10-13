/**
 * Normalizes a thrown value into a proper `Error` instance so the
 * console report carries a useful title and stack trace.
 *
 * HeyAPI's `throwOnError: true` throws the HTTP response body verbatim
 * as a plain object (e.g. `{ detail: "..." }`). Only `Error` instances
 * carry a meaningful title and stack — plain objects stringify into an
 * unreadable blob.
 */
export function normalizeToError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }

  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    const detail = obj.detail;
    if (typeof detail === "string") {
      const err = new Error(detail);
      err.cause = value;
      return err;
    }
    const message = obj.message;
    if (typeof message === "string") {
      const err = new Error(message);
      err.cause = value;
      return err;
    }
    try {
      const err = new Error(JSON.stringify(value));
      err.cause = value;
      return err;
    } catch {
      const err = new Error("Non-serializable error object");
      err.cause = value;
      return err;
    }
  }

  return new Error(String(value));
}
