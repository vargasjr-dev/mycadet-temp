/**
 * Platform terminal API client.
 *
 * Wraps the Django terminal session endpoints that proxy through vembda to
 * open K8s exec streams into cloud assistant containers. Same transport
 * the web UI's xterm.js terminal uses.
 */

import { loopbackSafeFetch } from "./loopback-fetch.js";
import { authHeaders, getCloudUrl } from "./cloud-client.js";
import { z } from "zod";

const TerminalSessionResponseSchema = z.object({ session_id: z.string() });

const TerminalOutputEventSchema = z.object({
  seq: z.number(),
  /** Base64-encoded PTY output bytes. */
  data: z.string(),
});

export type TerminalOutputEvent = z.infer<typeof TerminalOutputEventSchema>;

// ---------------------------------------------------------------------------
// Create / Close
// ---------------------------------------------------------------------------

export async function createTerminalSession(
  token: string,
  assistantId: string,
  cols: number,
  rows: number,
  cloudUrl?: string,
  service?: string,
): Promise<{ session_id: string }> {
  const baseUrl = cloudUrl || getCloudUrl();
  const body: Record<string, unknown> = { cols, rows };
  if (service) {
    body.service = service;
  }
  const response = await loopbackSafeFetch(
    `${baseUrl}/v1/assistants/${assistantId}/terminal/sessions/`,
    {
      method: "POST",
      headers: await authHeaders(token, cloudUrl),
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Failed to create terminal session (${response.status}): ${detail || response.statusText}`,
    );
  }
  const parsed = TerminalSessionResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error("Terminal session response did not include a session_id.");
  }
  return parsed.data;
}

export async function closeTerminalSession(
  token: string,
  assistantId: string,
  sessionId: string,
  cloudUrl?: string,
): Promise<void> {
  const baseUrl = cloudUrl || getCloudUrl();
  const response = await loopbackSafeFetch(
    `${baseUrl}/v1/assistants/${assistantId}/terminal/sessions/${sessionId}/`,
    {
      method: "DELETE",
      headers: await authHeaders(token, cloudUrl),
    },
  );
  // 404 = already closed, treat as success
  if (!response.ok && response.status !== 404) {
    throw new Error(
      `Failed to close terminal session (${response.status}): ${response.statusText}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Input / Resize
// ---------------------------------------------------------------------------

export async function sendTerminalInput(
  token: string,
  assistantId: string,
  sessionId: string,
  data: string,
  cloudUrl?: string,
): Promise<void> {
  const baseUrl = cloudUrl || getCloudUrl();
  const response = await loopbackSafeFetch(
    `${baseUrl}/v1/assistants/${assistantId}/terminal/sessions/${sessionId}/input/`,
    {
      method: "POST",
      headers: await authHeaders(token, cloudUrl),
      body: JSON.stringify({ data }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Failed to send terminal input (${response.status}): ${response.statusText}`,
    );
  }
}

export async function resizeTerminalSession(
  token: string,
  assistantId: string,
  sessionId: string,
  cols: number,
  rows: number,
  cloudUrl?: string,
): Promise<void> {
  const baseUrl = cloudUrl || getCloudUrl();
  const response = await loopbackSafeFetch(
    `${baseUrl}/v1/assistants/${assistantId}/terminal/sessions/${sessionId}/resize/`,
    {
      method: "POST",
      headers: await authHeaders(token, cloudUrl),
      body: JSON.stringify({ cols, rows }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Failed to resize terminal (${response.status}): ${response.statusText}`,
    );
  }
}

// ---------------------------------------------------------------------------
// SSE event stream
// ---------------------------------------------------------------------------

/**
 * Subscribe to the terminal output SSE stream. Yields parsed events as they
 * arrive. The generator completes when the stream ends or is aborted.
 */
export async function* subscribeTerminalEvents(
  token: string,
  assistantId: string,
  sessionId: string,
  cloudUrl?: string,
  signal?: AbortSignal,
): AsyncGenerator<TerminalOutputEvent> {
  const baseUrl = cloudUrl || getCloudUrl();
  const response = await loopbackSafeFetch(
    `${baseUrl}/v1/assistants/${assistantId}/terminal/sessions/${sessionId}/events/`,
    {
      headers: await authHeaders(token, cloudUrl),
      signal,
    },
  );

  if (!response.ok || !response.body) {
    throw new Error(
      `SSE connection failed (${response.status}): ${response.statusText}`,
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      // Keep the last incomplete line in the buffer
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trimEnd();
        if (trimmed.startsWith("data: ")) {
          try {
            const frame = TerminalOutputEventSchema.safeParse(
              JSON.parse(trimmed.slice(6)),
            );
            if (frame.success) yield frame.data;
          } catch {
            // Skip malformed SSE frames
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
