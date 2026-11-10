/**
 * The assistant's doctor-session surface, proxied to the cloud on the
 * assistant's own credentials (the shared {@link forwardToCloud}).
 *
 * Doctor sessions are cloud-only: the cloud runs the session, holds the
 * persisted history, and streams the events. The gateway holds none of
 * that state — every dial here is a verbatim proxy. The event stream is
 * the one long-lived surface: its handler passes `streaming` so the hop
 * binds the upstream fetch to the caller's disconnect signal instead of
 * its fixed timeout, and the session's replay cursor rides through as a
 * `Last-Event-ID` header. Like the daemon's event stream, the SSE route
 * stays off the published spec — the web bundle dials it through the
 * client's raw `sse` helper.
 */

import { z } from "zod";

import { forwardToCloud } from "./cloud-hop.js";
import type { RouteDefinition } from "./types.js";

// The cloud's persisted history shapes, declared as the panel reads them —
// the arms proxy the cloud verbatim; the fields below are the subset the
// doctor panel consumes (the session's status and its message list).
const DoctorMessageSchema = z.object({
  id: z.string(),
  kind: z.enum([
    "user",
    "assistant",
    "tool_call",
    "tool_result",
    "approval",
    "status",
    "error",
  ]),
  content: z.string(),
  metadata: z.unknown(),
  sequence: z.number(),
  source_event_id: z.string().nullable(),
  occurred_at: z.string(),
});

// The cloud's paginated history list — the doctor panel reads the latest
// session's id off `results`.
const DoctorHistoryListSchema = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      status: z.string(),
      last_message_at: z.string().nullable(),
      created: z.string(),
    }).passthrough(),
  ),
}).passthrough();

// A persisted doctor session (its messages map to the panel's entries).
const DoctorHistorySessionSchema = z.object({
  status: z.enum(["active", "completed", "error"]),
  messages: z.array(DoctorMessageSchema),
  user_outcome: z.string().nullable(),
}).passthrough();

// The cloud's session record — the panel reads the session id off it and
// rides it on every subsequent dial.
const DoctorSessionSchema = z.object({
  session_id: z.string(),
}).passthrough();

// The guardian's message into the session.
const DoctorMessageRequestSchema = z.object({
  content: z.string(),
  source_event_id: z.string().nullable().optional(),
}).passthrough();

export const ROUTES: RouteDefinition[] = [
  {
    path: "/doctor/history",
    method: "get",
    operationId: "doctorHistoryList",
    summary: "List persisted doctor sessions",
    description:
      "The cloud's persisted doctor sessions for this assistant, proxied " +
      "on the assistant's own credentials. Query parameters (limit, " +
      "cursor) pass through verbatim.",
    tags: ["doctor"],
    queryParameters: [{ name: "limit", description: "Page size" }],
    responseBody: DoctorHistoryListSchema,
    auth: "edge-scoped",
    scope: "chat.read",
    scoped: true,
    handler: (req) => forwardToCloud(req, "/doctor/history/"),
  },
  {
    path: "/doctor/history/{doctor_session_id}",
    method: "get",
    operationId: "doctorHistoryRetrieve",
    summary: "Retrieve a persisted doctor session",
    description:
      "One persisted doctor session with its messages, proxied on the " +
      "assistant's own credentials.",
    tags: ["doctor"],
    pathParameters: [
      { name: "doctor_session_id", description: "The doctor session id" },
    ],
    responseBody: DoctorHistorySessionSchema,
    auth: "edge-scoped",
    scope: "chat.read",
    scoped: true,
    handler: (req, params) =>
      forwardToCloud(req, `/doctor/history/${encodeURIComponent(params[0])}/`),
  },
  {
    path: "/doctor/sessions",
    method: "post",
    operationId: "doctorSessionsCreate",
    summary: "Start a doctor session",
    description:
      "A cloud write, proxied on the assistant's own credentials. The " +
      "cloud opens the session and answers its record.",
    tags: ["doctor"],
    requestBody: z.object({}).passthrough().optional(),
    responseBody: DoctorSessionSchema,
    auth: "edge-scoped",
    scope: "chat.write",
    scoped: true,
    handler: (req) => forwardToCloud(req, "/doctor/sessions/"),
  },
  {
    path: "/doctor/sessions/{session_id}",
    method: "delete",
    operationId: "doctorSessionsDestroy",
    summary: "End a doctor session",
    description:
      "A cloud write, proxied on the assistant's own credentials — the " +
      "session id rides the upstream path.",
    tags: ["doctor"],
    pathParameters: [{ name: "session_id", description: "The session id" }],
    auth: "edge-scoped",
    scope: "chat.write",
    scoped: true,
    handler: (req, params) =>
      forwardToCloud(req, `/doctor/sessions/${encodeURIComponent(params[0])}/`),
  },
  {
    path: "/doctor/sessions/{session_id}/events",
    method: "get",
    summary: "Stream a doctor session's events",
    description:
      "The session's SSE event stream, proxied on the assistant's own " +
      "credentials with the hop in streaming mode — no fixed timeout; the " +
      "upstream fetch dies with the caller's disconnect. A `Last-Event-ID` " +
      "header replays from the given cursor.",
    tags: ["doctor"],
    pathParameters: [{ name: "session_id", description: "The session id" }],
    auth: "edge-scoped",
    scope: "chat.read",
    scoped: true,
    handler: (req, params) =>
      forwardToCloud(
        req,
        `/doctor/sessions/${encodeURIComponent(params[0])}/events/`,
        { streaming: true },
      ),
  },
  {
    path: "/doctor/sessions/{session_id}/messages",
    method: "post",
    operationId: "doctorSessionsMessagesCreate",
    summary: "Post a doctor message",
    description:
      "A cloud write, proxied on the assistant's own credentials — the " +
      "guardian's message into the doctor session.",
    tags: ["doctor"],
    pathParameters: [{ name: "session_id", description: "The session id" }],
    requestBody: DoctorMessageRequestSchema,
    responseBody: z.object({}).passthrough(),
    auth: "edge-scoped",
    scope: "chat.write",
    scoped: true,
    handler: (req, params) =>
      forwardToCloud(
        req,
        `/doctor/sessions/${encodeURIComponent(params[0])}/messages/`,
      ),
  },
  {
    path: "/doctor/sessions/{session_id}/user-outcome",
    method: "post",
    operationId: "doctorSessionsUserOutcomeCreate",
    summary: "Record a doctor session outcome",
    description:
      "A cloud write, proxied on the assistant's own credentials — the " +
      "guardian's answer to a session prompt.",
    tags: ["doctor"],
    pathParameters: [{ name: "session_id", description: "The session id" }],
    requestBody: z.object({}).passthrough(),
    responseBody: z.object({}).passthrough(),
    auth: "edge-scoped",
    scope: "chat.write",
    scoped: true,
    handler: (req, params) =>
      forwardToCloud(
        req,
        `/doctor/sessions/${encodeURIComponent(params[0])}/user-outcome/`,
      ),
  },
];
