/**
 * Route definitions for inference-profile session open/close/list operations.
 *
 * POST /v1/conversations/inference-profile-session       — open (or replace) a session
 * POST /v1/conversations/inference-profile-session/close — close an active session
 * GET  /v1/conversations/inference-profile-sessions      — list active sessions
 */
import { z } from "zod";

import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { BadRequestError } from "./errors.js";
import {
  closeInferenceProfileSession,
  listInferenceProfileSessionsWithRemaining,
  setInferenceProfileSession,
} from "./inference-profile-session-handler.js";
import { inferenceProfileSessionResponseSchema } from "./inference-profile-session-schema.js";
import { parseBody } from "./parse-body.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleOpenInferenceProfileSession({
  body = {},
  headers,
}: RouteHandlerArgs) {
  if (body.profile == null || typeof body.profile !== "string") {
    throw new BadRequestError("profile must be a non-empty string");
  }
  const request = parseBody(openInferenceProfileSessionRequestSchema, body);
  return setInferenceProfileSession({
    conversationId: request.conversationId,
    profile: body.profile,
    ttlSeconds: request.ttlSeconds,
    sessionId: request.sessionId,
    originClientId: headers?.["x-cadet-client-id"]?.trim() || undefined,
  });
}

async function handleCloseInferenceProfileSession({
  body = {},
  headers,
}: RouteHandlerArgs) {
  const request = parseBody(closeInferenceProfileSessionRequestSchema, body);
  return closeInferenceProfileSession(
    request.conversationId,
    headers?.["x-cadet-client-id"]?.trim() || undefined,
  );
}

function handleListInferenceProfileSessions({
  queryParams = {},
}: RouteHandlerArgs) {
  return {
    sessions: listInferenceProfileSessionsWithRemaining(
      queryParams.conversationId,
    ),
  };
}

// ---------------------------------------------------------------------------
// Transport-agnostic route definitions
// ---------------------------------------------------------------------------

export const closeInferenceProfileSessionResponseSchema = z.object({
  conversationId: z.string(),
  closed: z
    .object({
      profile: z.string().nullable(),
      sessionId: z.string().nullable(),
    })
    .nullable(),
  noop: z.boolean(),
});

export const listInferenceProfileSessionsResponseSchema = z.object({
  sessions: z.array(
    z.object({
      conversationId: z.string(),
      conversationTitle: z.string().nullable(),
      profile: z.string(),
      sessionId: z.string(),
      expiresAt: z.number(),
      remainingSeconds: z.number(),
    }),
  ),
});

const openInferenceProfileSessionRequestSchema = z.object({
  conversationId: z.string().min(1),
  profile: z.string().min(1),
  ttlSeconds: z.number().positive().nullable().optional(),
  sessionId: z.string().uuid().optional(),
});

const closeInferenceProfileSessionRequestSchema = z.object({
  conversationId: z.string().min(1),
});

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "inference_profile_open",
    endpoint: "conversations/inference-profile-session",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Open an inference-profile session",
    description:
      "Open (or replace) a session-backed inference-profile override for a conversation. " +
      "Supports an optional TTL — omit for a sticky (non-expiring) override. " +
      "A profile that provably cannot dispatch is rejected rather than pinned.",
    tags: ["conversations"],
    requestBody: openInferenceProfileSessionRequestSchema,
    responseBody: inferenceProfileSessionResponseSchema,
    handler: handleOpenInferenceProfileSession,
  },
  {
    operationId: "inference_profile_close",
    endpoint: "conversations/inference-profile-session/close",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Close an inference-profile session",
    description:
      "Close the active session-backed inference-profile override for a conversation. " +
      "Only closes session-backed overrides; sticky overrides are left untouched.",
    tags: ["conversations"],
    requestBody: closeInferenceProfileSessionRequestSchema,
    responseBody: closeInferenceProfileSessionResponseSchema,
    handler: handleCloseInferenceProfileSession,
  },
  {
    operationId: "inference_profile_list",
    endpoint: "conversations/inference-profile-sessions",
    method: "GET",
    policy: {
      requiredScopes: ["chat.read"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "List active inference-profile sessions",
    description:
      "List all active (non-expired) session-backed inference-profile overrides, " +
      "optionally filtered by conversationId.",
    tags: ["conversations"],
    queryParams: [
      {
        name: "conversationId",
        schema: { type: "string" },
        description: "Optional conversation ID filter",
      },
    ],
    responseBody: listInferenceProfileSessionsResponseSchema,
    handler: handleListInferenceProfileSessions,
  },
];
