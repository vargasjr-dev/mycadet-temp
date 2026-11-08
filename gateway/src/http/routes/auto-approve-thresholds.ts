/**
 * Auto-approve threshold CRUD endpoints for the gateway.
 *
 * Global thresholds: GET/PUT on the singleton `autoApproveThresholds` row.
 * Per-conversation overrides: GET/PUT/DELETE on `conversationThresholdOverrides`.
 */

import { eq, sql } from "drizzle-orm";

import { getGatewayDb } from "../../db/connection.js";
import {
  autoApproveThresholds,
  conversationThresholdOverrides,
} from "../../db/schema.js";
import { getLogger } from "../../logger.js";

import { z } from "zod";
import type { RouteDefinition } from "./types.js";
const log = getLogger("auto-approve-thresholds");

// ---------------------------------------------------------------------------
// Shared validation
// ---------------------------------------------------------------------------

export const VALID_THRESHOLDS = ["none", "low", "medium", "high"] as const;

/** Shared 400 text for the PUT bodies. */
function thresholdsBodyError(error: z.ZodError): string {
  if (error.issues.some((issue) => issue.path.length === 0)) {
    return "Request body must be a JSON object";
  }
  const details = error.issues
    .map(
      (issue) =>
        `"${String(issue.path[0])}" must be one of: ${VALID_THRESHOLDS.join(", ")}`,
    )
    .join("; ");
  return `Invalid request body: ${details}`;
}

// ---------------------------------------------------------------------------
// GET /v1/permissions/thresholds — global thresholds
// ---------------------------------------------------------------------------

export async function handleGlobalThresholdGet(
  _req: Request,
): Promise<Response> {
  try {
    const db = getGatewayDb();
    const row = db
      .select()
      .from(autoApproveThresholds)
      .where(eq(autoApproveThresholds.id, 1))
      .get();

    if (!row) {
      // Return defaults when no row exists yet
      return Response.json({
        interactive: "medium",
        autonomous: "low",
        headless: "none",
      });
    }

    return Response.json({
      interactive: row.interactive,
      autonomous: row.autonomous,
      headless: row.headless,
    });
  } catch (err) {
    log.error({ err }, "Failed to read global thresholds");
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// PUT /v1/permissions/thresholds — upsert global thresholds
// ---------------------------------------------------------------------------

export async function handleGlobalThresholdPut(
  req: Request,
): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json(
      { error: "Request body must be valid JSON" },
      { status: 400 },
    );
  }

  const parsed = GlobalThresholdsPutSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: thresholdsBodyError(parsed.error) },
      { status: 400 },
    );
  }

  const { interactive, autonomous, headless } = parsed.data;

  try {
    const db = getGatewayDb();
    const row = db
      .insert(autoApproveThresholds)
      .values({
        id: 1,
        ...(interactive ? { interactive } : {}),
        ...(autonomous ? { autonomous } : {}),
        ...(headless ? { headless } : {}),
      })
      .onConflictDoUpdate({
        target: autoApproveThresholds.id,
        set: {
          ...(interactive ? { interactive } : {}),
          ...(autonomous ? { autonomous } : {}),
          ...(headless ? { headless } : {}),
          updatedAt: sql`datetime('now')`,
        },
      })
      .returning()
      .get();

    return Response.json({
      interactive: row.interactive,
      autonomous: row.autonomous,
      headless: row.headless,
    });
  } catch (err) {
    log.error({ err }, "Failed to upsert global thresholds");
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// GET /v1/permissions/thresholds/conversations/:conversationId
// ---------------------------------------------------------------------------
//
// Returns 200 with `{ threshold: <value> }` when an override exists, and
// 200 with `{ threshold: null }` when no override exists for the given
// conversation. Treating "no override" as a normal 200 result (rather than
// 404) avoids surfacing a misleading network error in the browser console
// for what is the common case — most conversations have no override —
// and keeps the HTTP response shape consistent with the IPC contract,
// which already returns `null` for the same condition.
// ---------------------------------------------------------------------------

export async function handleConversationThresholdGet(
  _req: Request,
  params: string[],
): Promise<Response> {
  const conversationId = params[0];
  if (!conversationId) {
    return Response.json(
      { error: "conversationId is required" },
      { status: 400 },
    );
  }

  try {
    const db = getGatewayDb();
    const row = db
      .select()
      .from(conversationThresholdOverrides)
      .where(eq(conversationThresholdOverrides.conversationId, conversationId))
      .get();

    if (!row) {
      return Response.json({ threshold: null });
    }

    return Response.json({ threshold: row.threshold });
  } catch (err) {
    log.error(
      { err, conversationId },
      "Failed to read conversation threshold override",
    );
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// PUT /v1/permissions/thresholds/conversations/:conversationId
// ---------------------------------------------------------------------------

export async function handleConversationThresholdPut(
  req: Request,
  params: string[],
): Promise<Response> {
  const conversationId = params[0];
  if (!conversationId) {
    return Response.json(
      { error: "conversationId is required" },
      { status: 400 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json(
      { error: "Request body must be valid JSON" },
      { status: 400 },
    );
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json(
      { error: "Request body must be a JSON object" },
      { status: 400 },
    );
  }

  const parsed = ConversationThresholdPutSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: thresholdsBodyError(parsed.error) },
      { status: 400 },
    );
  }

  const { threshold } = parsed.data;

  try {
    const db = getGatewayDb();
    db.insert(conversationThresholdOverrides)
      .values({
        conversationId,
        threshold,
      })
      .onConflictDoUpdate({
        target: conversationThresholdOverrides.conversationId,
        set: {
          threshold,
          updatedAt: sql`datetime('now')`,
        },
      })
      .run();

    return Response.json({ conversationId, threshold });
  } catch (err) {
    log.error(
      { err, conversationId },
      "Failed to upsert conversation threshold override",
    );
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// DELETE /v1/permissions/thresholds/conversations/:conversationId
// ---------------------------------------------------------------------------

export async function handleConversationThresholdDelete(
  _req: Request,
  params: string[],
): Promise<Response> {
  const conversationId = params[0];
  if (!conversationId) {
    return Response.json(
      { error: "conversationId is required" },
      { status: 400 },
    );
  }

  try {
    const db = getGatewayDb();
    db.delete(conversationThresholdOverrides)
      .where(eq(conversationThresholdOverrides.conversationId, conversationId))
      .run();

    // 204 No Content — idempotent, succeeds even if row didn't exist
    return new Response(null, { status: 204 });
  } catch (err) {
    log.error(
      { err, conversationId },
      "Failed to delete conversation threshold override",
    );
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

const ThresholdSchema = z.enum(["none", "low", "medium", "high"]);

const GlobalThresholdsSchema = z.object({
  interactive: ThresholdSchema,
  autonomous: ThresholdSchema,
  headless: ThresholdSchema,
});

const GlobalThresholdsPutSchema = z.object({
  interactive: ThresholdSchema.optional(),
  autonomous: ThresholdSchema.optional(),
  headless: ThresholdSchema.optional(),
});

const ConversationThresholdPutSchema = z.object({ threshold: ThresholdSchema });

export const ROUTES: RouteDefinition[] = [
  {
    path: "/permissions/thresholds",
    method: "get",
    operationId: "permissionsThresholdsGet",
    summary: "Get global auto-approve thresholds",
    tags: ["permissions"],
    responseBody: GlobalThresholdsSchema,
    auth: "edge-scoped",
    scope: "settings.read",
    scoped: true,
    handler: handleGlobalThresholdGet,
  },
  {
    path: "/permissions/thresholds",
    method: "put",
    operationId: "permissionsThresholdsPut",
    summary: "Update global auto-approve thresholds",
    description:
      "Partial update — omitted modes keep their current value. Returns the full post-update set.",
    tags: ["permissions"],
    requestBody: GlobalThresholdsPutSchema,
    responseBody: GlobalThresholdsSchema,
    auth: "edge-scoped",
    scope: "settings.write",
    scoped: true,
    handler: handleGlobalThresholdPut,
  },
  {
    path: "/permissions/thresholds/conversations/{conversation_id}",
    method: "get",
    operationId: "conversationThresholdGet",
    summary: "Get a conversation's threshold override",
    description:
      "Returns { threshold: null } when no override exists. Gateways predating that behavior returned 404 for the same condition; clients tolerate both during rollout.",
    tags: ["permissions"],
    pathParameters: [
      { name: "conversation_id", description: "The conversation id" },
    ],
    responseBody: z.object({ threshold: z.string().nullable() }),
    auth: "edge-scoped",
    scope: "settings.read",
    scoped: true,
    handler: handleConversationThresholdGet,
  },
  {
    path: "/permissions/thresholds/conversations/{conversation_id}",
    method: "put",
    operationId: "conversationThresholdPut",
    summary: "Set a conversation's threshold override",
    tags: ["permissions"],
    pathParameters: [
      { name: "conversation_id", description: "The conversation id" },
    ],
    requestBody: ConversationThresholdPutSchema,
    responseBody: z.object({
      conversationId: z.string(),
      threshold: ThresholdSchema,
    }),
    auth: "edge-scoped",
    scope: "settings.write",
    scoped: true,
    handler: handleConversationThresholdPut,
  },
  {
    path: "/permissions/thresholds/conversations/{conversation_id}",
    method: "delete",
    operationId: "conversationThresholdDelete",
    summary: "Clear a conversation's threshold override",
    description: "Idempotent — succeeds even when no override exists.",
    tags: ["permissions"],
    pathParameters: [
      { name: "conversation_id", description: "The conversation id" },
    ],
    responseStatus: "204",
    auth: "edge-scoped",
    scope: "settings.write",
    scoped: true,
    handler: handleConversationThresholdDelete,
  },
];
