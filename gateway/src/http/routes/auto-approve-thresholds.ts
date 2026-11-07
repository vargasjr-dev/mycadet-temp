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
import type { GatewayRouteDefinition } from "./types.js";
const log = getLogger("auto-approve-thresholds");

// ---------------------------------------------------------------------------
// Shared validation
// ---------------------------------------------------------------------------

export const VALID_THRESHOLDS = ["none", "low", "medium", "high"] as const;
type Threshold = (typeof VALID_THRESHOLDS)[number];

function isValidThreshold(value: unknown): value is Threshold {
  return (
    typeof value === "string" && VALID_THRESHOLDS.includes(value as Threshold)
  );
}

// ---------------------------------------------------------------------------
// GET /v1/permissions/thresholds — global thresholds
// ---------------------------------------------------------------------------

export function createGlobalThresholdGetHandler() {
  return async (_req: Request): Promise<Response> => {
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
  };
}

// ---------------------------------------------------------------------------
// PUT /v1/permissions/thresholds — upsert global thresholds
// ---------------------------------------------------------------------------

export function createGlobalThresholdPutHandler() {
  return async (req: Request): Promise<Response> => {
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

    const { interactive, autonomous, headless } = body as Record<
      string,
      unknown
    >;

    if (interactive !== undefined && !isValidThreshold(interactive)) {
      return Response.json(
        {
          error: `"interactive" must be one of: ${VALID_THRESHOLDS.join(", ")}`,
        },
        { status: 400 },
      );
    }
    if (autonomous !== undefined && !isValidThreshold(autonomous)) {
      return Response.json(
        {
          error: `"autonomous" must be one of: ${VALID_THRESHOLDS.join(", ")}`,
        },
        { status: 400 },
      );
    }
    if (headless !== undefined && !isValidThreshold(headless)) {
      return Response.json(
        {
          error: `"headless" must be one of: ${VALID_THRESHOLDS.join(", ")}`,
        },
        { status: 400 },
      );
    }

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
  };
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

export function createConversationThresholdGetHandler() {
  return async (_req: Request, params: string[]): Promise<Response> => {
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
        .where(
          eq(conversationThresholdOverrides.conversationId, conversationId),
        )
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
  };
}

// ---------------------------------------------------------------------------
// PUT /v1/permissions/thresholds/conversations/:conversationId
// ---------------------------------------------------------------------------

export function createConversationThresholdPutHandler() {
  return async (req: Request, params: string[]): Promise<Response> => {
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

    const { threshold } = body as Record<string, unknown>;

    if (!isValidThreshold(threshold)) {
      return Response.json(
        {
          error: `"threshold" must be one of: ${VALID_THRESHOLDS.join(", ")}`,
        },
        { status: 400 },
      );
    }

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
  };
}

// ---------------------------------------------------------------------------
// DELETE /v1/permissions/thresholds/conversations/:conversationId
// ---------------------------------------------------------------------------

export function createConversationThresholdDeleteHandler() {
  return async (_req: Request, params: string[]): Promise<Response> => {
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
        .where(
          eq(conversationThresholdOverrides.conversationId, conversationId),
        )
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
  };
}

const ThresholdSchema = z.enum(["none", "low", "medium", "high"]);

const GlobalThresholdsSchema = z.object({
  interactive: ThresholdSchema,
  autonomous: ThresholdSchema,
  headless: ThresholdSchema,
});

export const ROUTES: GatewayRouteDefinition[] = [
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
    handler: createGlobalThresholdGetHandler(),
  },
  {
    path: "/permissions/thresholds",
    method: "put",
    operationId: "permissionsThresholdsPut",
    summary: "Update global auto-approve thresholds",
    description:
      "Partial update — omitted modes keep their current value. Returns the full post-update set.",
    tags: ["permissions"],
    requestBody: z.object({
      interactive: ThresholdSchema.optional(),
      autonomous: ThresholdSchema.optional(),
      headless: ThresholdSchema.optional(),
    }),
    responseBody: GlobalThresholdsSchema,
    auth: "edge-scoped",
    scope: "settings.write",
    scoped: true,
    handler: createGlobalThresholdPutHandler(),
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
    handler: createConversationThresholdGetHandler(),
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
    requestBody: z.object({ threshold: ThresholdSchema }),
    responseBody: z.object({
      conversationId: z.string(),
      threshold: ThresholdSchema,
    }),
    auth: "edge-scoped",
    scope: "settings.write",
    scoped: true,
    handler: createConversationThresholdPutHandler(),
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
    handler: createConversationThresholdDeleteHandler(),
  },
];
