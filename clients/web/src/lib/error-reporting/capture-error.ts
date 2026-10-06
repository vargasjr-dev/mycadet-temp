import { isExpectedDaemonTransientError } from "@/utils/daemon-errors";
import { isCancellationError } from "@/utils/is-cancellation-error";
import { isTransientNetworkError } from "@/utils/is-transient-network-error";

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

// Re-export so existing `import { isExpectedDaemonTransientError } from
// "@/lib/error-reporting/capture-error"` call sites keep working during migration.
// Canonical home is `@/utils/daemon-errors`.
export { isExpectedDaemonTransientError } from "@/utils/daemon-errors";

/**
 * Reports a non-transient error to the console with structured context.
 *
 * Transient browser-level fetch failures (network drop, DNS timeout,
 * device sleep) are silently dropped — they are not application bugs
 * and the app handles them gracefully via TanStack Query retries,
 * best-effort sync patterns, and error-state UI.
 *
 * Cancellation errors (TanStack `CancelledError`, `AbortError`) are
 * likewise dropped: they mean the operation was cancelled on purpose
 * (unmount mid-fetch, invalidation restarting an in-flight refetch,
 * an aborted request), which is control flow, not failure. See
 * `isCancellationError` in `utils/`.
 *
 * When `bestEffort` is `true`, expected daemon transient HTTP errors
 * (503/502/401/400-org-header) are also silently dropped. Use this for
 * background fetches that fire optimistically and have natural retry
 * surfaces (SSE reconnect, dependency-change re-renders, navigation).
 *
 * Non-Error values (e.g. HeyAPI response bodies thrown by
 * `throwOnError: true`) are normalized into `Error` instances before
 * logging so the report carries a useful title and stack.
 *
 * All manual error reporting should go through this function so that
 * transient-error filtering and context conventions are applied
 * consistently.
 */
export function captureError(
  error: unknown,
  opts: {
    context: string;
    level?: "warning" | "info" | "error" | "fatal";
    tags?: Record<string, string>;
    extra?: Record<string, unknown>;
    bestEffort?: boolean;
  },
): void {
  if (isTransientNetworkError(error)) {
    return;
  }
  if (isCancellationError(error)) {
    return;
  }
  if (opts.bestEffort && isExpectedDaemonTransientError(error)) {
    return;
  }

  const normalized = normalizeToError(error);
  const extra: Record<string, unknown> = { ...opts.extra };
  if (normalized !== error) {
    extra.originalError = error;
  }

  const detail: Record<string, unknown> = {};
  if (opts.tags && Object.keys(opts.tags).length > 0) {
    detail.tags = opts.tags;
  }
  if (Object.keys(extra).length > 0) {
    detail.extra = extra;
  }

  const message = `[${opts.context}]`;
  const reported = Object.keys(detail).length > 0 ? detail : "";
  if (opts.level === "warning" || opts.level === "info") {
    console.warn(message, normalized, reported);
    return;
  }
  console.error(message, normalized, reported);
}
