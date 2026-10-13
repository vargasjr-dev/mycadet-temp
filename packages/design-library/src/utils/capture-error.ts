import { normalizeToError } from "./normalize-error";
import { isCancellationError } from "./is-cancellation-error";
import { isTransientNetworkError } from "./is-transient-network-error";

export type CaptureErrorOptions = {
  context: string;
  level?: "warning" | "info" | "error" | "fatal";
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
};

/** Error reporting with cancellation and network-failure filtering. */
export function captureError(error: unknown, opts: CaptureErrorOptions): void {
  if (isTransientNetworkError(error)) {
    return;
  }
  if (isCancellationError(error)) {
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
