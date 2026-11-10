/**
 * The doctor event stream, dialed directly — the app bundle has no
 * generated SDK to borrow an SSE helper from, so this is the whole
 * transport: a fetch on the operator surface's unscoped events route,
 * parsed with the shared SSE payload normalizer. No retries (the caller's
 * reconnect budget owns that), and the caller's abort controller tears
 * the stream down.
 */

import {
  normalizeSSEPayload,
  unwrapMessageEnvelope,
} from "@app/lib/streaming/sse-payload";

export interface OperatorSseEvent {
  /** The parsed `data:` frame, or `undefined` for a heartbeat comment. */
  data?: Record<string, unknown>;
}

/** A failed stream dial: the status, and the 409 replay-gap code when present. */
export class OperatorSseError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, code: string | null = null) {
    super(
      code
        ? `Doctor stream failed (${status}, ${code}).`
        : `Doctor stream failed (HTTP ${status}).`,
    );
    this.name = "OperatorSseError";
    this.status = status;
    this.code = code;
  }
}

export interface OperatorSseOptions {
  path: string;
  headers?: Record<string, string>;
  signal: AbortSignal;
  onSseEvent: (event: OperatorSseEvent) => void | Promise<void>;
  onSseError: (error: unknown) => void;
}

/**
 * Open the stream and pump it until aborted or the server closes it.
 * Resolves when the stream ends (never throws — errors surface through
 * `onSseError`), so the caller's loop reads like the SDK iterator did.
 */
export async function streamOperatorSse(
  options: OperatorSseOptions,
): Promise<void> {
  const { path, headers, signal, onSseEvent, onSseError } = options;
  try {
    const response = await fetch(path, {
      headers: {
        Accept: "text/event-stream",
        ...headers,
      },
      signal,
    });
    if (!response.ok || !response.body) {
      let code: string | null = null;
      if (response.status === 409) {
        const body = (await response
          .clone()
          .json()
          .catch(() => null)) as { code?: unknown } | null;
        code = typeof body?.code === "string" ? body.code : null;
      }
      onSseError(new OperatorSseError(response.status, code));
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line; the daemon also emits
      // heartbeat comment frames (`: keepalive`) that carry no data.
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const dataLines = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim());
        if (dataLines.length === 0) {
          // A comment or event with no data — still traffic for the caller's
          // watchdog, surfaced as a heartbeat.
          await onSseEvent({});
          continue;
        }
        const payload = normalizeSSEPayload(dataLines.join("\n"));
        if (payload) {
          await onSseEvent({ data: unwrapMessageEnvelope(payload) });
        } else {
          await onSseEvent({});
        }
      }
    }
  } catch (err) {
    // An AbortError from the caller's controller is a clean teardown.
    if (err instanceof DOMException && err.name === "AbortError") {
      return;
    }
    onSseError(err);
  }
}
