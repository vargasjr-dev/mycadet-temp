/**
 * The assistant's terminal-session surface, proxied to the cloud on the
 * assistant's own credentials (the shared {@link forwardToCloud}).
 *
 * Terminal sessions are cloud-only: the cloud spawns and owns the PTY for
 * the assistant, so the gateway holds no terminal state of its own — every
 * dial here is a verbatim proxy. The event stream is the one long-lived
 * surface: its handler passes `streaming` so the hop binds the upstream
 * fetch to the caller's disconnect signal instead of its fixed timeout.
 * Like the daemon's event stream, the SSE route stays off the published
 * spec — the web bundle dials it through the client's raw `sse` helper.
 */

import { z } from "zod";

import { forwardToCloud } from "./cloud-hop.js";
import type { RouteDefinition } from "./types.js";

// The cloud's session record — its session id feeds the input/resize/
// destroy dials and the event stream.
const TerminalSessionSchema = z.object({
  session_id: z.string(),
}).passthrough();

export const ROUTES: RouteDefinition[] = [
  {
    path: "/terminal/sessions",
    method: "post",
    operationId: "terminalSessionsCreate",
    summary: "Create a terminal session",
    description:
      "A cloud write, proxied on the assistant's own credentials. The " +
      "cloud spawns the PTY and answers its session record.",
    tags: ["terminal"],
    requestBody: z.object({}).passthrough().optional(),
    responseBody: TerminalSessionSchema,
    auth: "edge-scoped",
    scope: "chat.write",
    scoped: true,
    handler: (req) => forwardToCloud(req, "/terminal/sessions/"),
  },
  {
    path: "/terminal/sessions/{session_id}",
    method: "delete",
    operationId: "terminalSessionsDestroy",
    summary: "Destroy a terminal session",
    description:
      "A cloud write, proxied on the assistant's own credentials — the " +
      "session id rides the upstream path.",
    tags: ["terminal"],
    pathParameters: [{ name: "session_id", description: "The session id" }],
    auth: "edge-scoped",
    scope: "chat.write",
    scoped: true,
    handler: (req, params) =>
      forwardToCloud(
        req,
        `/terminal/sessions/${encodeURIComponent(params[0])}/`,
      ),
  },
  {
    path: "/terminal/sessions/{session_id}/input",
    method: "post",
    operationId: "terminalSessionsInputCreate",
    summary: "Write to a terminal session",
    description:
      "A cloud write, proxied on the assistant's own credentials — PTY " +
      "input bytes batched by the web's terminal session hook.",
    tags: ["terminal"],
    pathParameters: [{ name: "session_id", description: "The session id" }],
    requestBody: z.object({}).passthrough(),
    responseBody: z.object({}).passthrough(),
    auth: "edge-scoped",
    scope: "chat.write",
    scoped: true,
    handler: (req, params) =>
      forwardToCloud(
        req,
        `/terminal/sessions/${encodeURIComponent(params[0])}/input/`,
      ),
  },
  {
    path: "/terminal/sessions/{session_id}/resize",
    method: "post",
    operationId: "terminalSessionsResizeCreate",
    summary: "Resize a terminal session",
    description:
      "A cloud write, proxied on the assistant's own credentials — the " +
      "web's debounced PTY resize.",
    tags: ["terminal"],
    pathParameters: [{ name: "session_id", description: "The session id" }],
    requestBody: z.object({}).passthrough(),
    responseBody: z.object({}).passthrough(),
    auth: "edge-scoped",
    scope: "chat.write",
    scoped: true,
    handler: (req, params) =>
      forwardToCloud(
        req,
        `/terminal/sessions/${encodeURIComponent(params[0])}/resize/`,
      ),
  },
  {
    path: "/terminal/sessions/{session_id}/events",
    method: "get",
    summary: "Stream a terminal session's output",
    description:
      "The session's SSE output stream, proxied on the assistant's own " +
      "credentials with the hop in streaming mode — no fixed timeout; the " +
      "upstream fetch dies with the caller's disconnect.",
    tags: ["terminal"],
    pathParameters: [{ name: "session_id", description: "The session id" }],
    auth: "edge-scoped",
    scope: "chat.read",
    scoped: true,
    handler: (req, params) =>
      forwardToCloud(
        req,
        `/terminal/sessions/${encodeURIComponent(params[0])}/events/`,
        { streaming: true },
      ),
  },
];
