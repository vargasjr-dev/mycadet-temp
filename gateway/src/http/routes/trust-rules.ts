/**
 * Trust rule v3 CRUD endpoints for the gateway.
 *
 * Mutations invalidate the in-memory risk rule cache so subsequent
 * classifications reflect the change immediately.
 */

import {
  TrustRuleStore,
  VALID_RISK_VALUES,
} from "../../db/trust-rule-store.js";
import { invalidateTrustRuleCache } from "../../risk/trust-rule-cache.js";
import { DEFAULT_COMMAND_REGISTRY } from "../../risk/command-registry/index.js";
import { getLogger } from "../../logger.js";
import { ipcSuggestTrustRule } from "../../ipc/assistant-client.js";
import { getGatewayDb } from "../../db/connection.js";
import { autoApproveThresholds } from "../../db/schema.js";
import { eq } from "drizzle-orm";

import { z } from "zod";
import type { RouteDefinition } from "./types.js";

const log = getLogger("trust-rules");

// ---------------------------------------------------------------------------
// Zod schemas for POST /v1/trust-rules/suggest — wire + published spec
// (single source)
// ---------------------------------------------------------------------------

const SuggestRequestSchema = z.object({
  tool: z.string().min(1),
  command: z.string().min(1),
  riskAssessment: z.object({
    risk: z.string(),
    reasoning: z.string(),
    reasonDescription: z.string(),
  }),
  scopeOptions: z.array(
    z.object({
      pattern: z.string(),
      label: z.string(),
    }),
  ),
  directoryScopeOptions: z
    .array(
      z.object({
        scope: z.string(),
        label: z.string(),
      }),
    )
    .optional(),
  intent: z.enum(["auto_approve", "escalate"]),
  existingRule: z
    .object({
      id: z.string(),
      pattern: z.string(),
      risk: z.string(),
    })
    .optional(),
});

export interface TrustRulesListParams {
  origin?: string;
  tool?: string;
  includeDeleted?: boolean;
  includeAll?: boolean;
}

export function listTrustRules(params: TrustRulesListParams = {}) {
  // Construct per call so DB resets use the current gateway DB connection.
  const store = new TrustRuleStore();
  const userRelevantOnly = !params.includeAll && params.origin === undefined;

  const rules = store.list({
    origin: params.origin,
    tool: params.tool,
    includeDeleted: params.includeDeleted,
    userRelevantOnly,
  });
  return { rules };
}

/**
 * Read the interactive auto-approve threshold from the DB.
 * Falls back to "low" if the DB is unavailable or the row is missing.
 */
function readInteractiveThreshold(): string {
  try {
    const db = getGatewayDb();
    const row = db
      .select()
      .from(autoApproveThresholds)
      .where(eq(autoApproveThresholds.id, 1))
      .get();
    return row?.interactive ?? "medium";
  } catch {
    return "low";
  }
}

// ---------------------------------------------------------------------------
// POST /v1/trust-rules/suggest — LLM-generated trust rule suggestion
// ---------------------------------------------------------------------------

export async function handleTrustRulesSuggest(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json(
      { error: "Request body must be valid JSON" },
      { status: 400 },
    );
  }

  const parsed = SuggestRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid request body", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const currentThreshold = readInteractiveThreshold();

  try {
    const suggestion = await ipcSuggestTrustRule({
      ...parsed.data,
      currentThreshold,
    });
    return Response.json({ suggestion });
  } catch (err) {
    log.error({ err }, "Trust rule suggestion failed");
    const message =
      err instanceof Error ? err.message : "Suggestion generation failed";
    return Response.json({ error: message }, { status: 503 });
  }
}

// ---------------------------------------------------------------------------
// GET /v1/trust-rules — list rules
// ---------------------------------------------------------------------------

export async function handleTrustRulesList(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const origin = url.searchParams.get("origin") ?? undefined;
    const tool = url.searchParams.get("tool") ?? undefined;
    const includeDeleted = url.searchParams.get("include_deleted") === "true";
    const includeAll = url.searchParams.get("include_all") === "true";

    return Response.json(
      listTrustRules({ origin, tool, includeDeleted, includeAll }),
    );
  } catch (err) {
    log.error({ err }, "Failed to list trust rules");
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// POST /v1/trust-rules — create rule
// ---------------------------------------------------------------------------

export async function handleTrustRulesCreate(req: Request): Promise<Response> {
  const store = new TrustRuleStore();

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

  const { tool, pattern, risk, description, scope } = body as Record<
    string,
    unknown
  >;

  if (typeof tool !== "string" || !tool) {
    return Response.json(
      { error: '"tool" must be a non-empty string' },
      { status: 400 },
    );
  }
  if (typeof pattern !== "string" || !pattern) {
    return Response.json(
      { error: '"pattern" must be a non-empty string' },
      { status: 400 },
    );
  }
  if (typeof risk !== "string" || !VALID_RISK_VALUES.has(risk)) {
    return Response.json(
      { error: '"risk" must be one of: low, medium, high' },
      { status: 400 },
    );
  }
  if (typeof description !== "string" || !description) {
    return Response.json(
      { error: '"description" must be a non-empty string' },
      { status: 400 },
    );
  }
  // The engine matches rules on (tool, pattern) only, so a directory scope
  // cannot narrow one. Storing a scoped request anyway would persist a rule
  // broader than the consent it records; refuse it instead. "everywhere"
  // is the one value that means what the store does, so it stays accepted
  // for clients that send it explicitly.
  if (scope !== undefined && scope !== "everywhere") {
    return Response.json(
      {
        error:
          'Trust rules apply workspace-wide; "scope" cannot narrow one. Omit it or send "everywhere".',
      },
      { status: 400 },
    );
  }

  try {
    const rule = store.create({
      tool,
      pattern,
      risk,
      description,
      scope: typeof scope === "string" ? scope : null,
    });
    invalidateTrustRuleCache();
    return Response.json({ rule }, { status: 201 });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to create trust rule";
    log.error({ err }, "Failed to create trust rule");
    return Response.json({ error: message }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// PATCH /v1/trust-rules/:id — update rule
// ---------------------------------------------------------------------------

export async function handleTrustRulesUpdate(
  req: Request,
  ruleId: string,
): Promise<Response> {
  const store = new TrustRuleStore();

  if (!ruleId) {
    return Response.json({ error: "Rule ID is required" }, { status: 400 });
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

  const { risk, description } = body as Record<string, unknown>;

  if (
    risk !== undefined &&
    (typeof risk !== "string" || !VALID_RISK_VALUES.has(risk))
  ) {
    return Response.json(
      { error: '"risk" must be one of: low, medium, high' },
      { status: 400 },
    );
  }

  if (description !== undefined && typeof description !== "string") {
    return Response.json(
      { error: '"description" must be a string' },
      { status: 400 },
    );
  }

  try {
    const rule = store.update(ruleId, {
      risk: risk as string | undefined,
      description: description as string | undefined,
    });
    invalidateTrustRuleCache();
    return Response.json({ rule });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Internal server error";
    if (message.includes("not found")) {
      return Response.json({ error: message }, { status: 404 });
    }
    log.error({ err }, "Failed to update trust rule");
    return Response.json({ error: message }, { status: 400 });
  }
}

// ---------------------------------------------------------------------------
// DELETE /v1/trust-rules/:id — delete rule
// ---------------------------------------------------------------------------

export async function handleTrustRulesDelete(
  _req: Request,
  ruleId: string,
): Promise<Response> {
  const store = new TrustRuleStore();

  if (!ruleId) {
    return Response.json({ error: "Rule ID is required" }, { status: 400 });
  }

  try {
    store.remove(ruleId);
    invalidateTrustRuleCache();
    return Response.json({ success: true });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Internal server error";
    if (message.includes("not found")) {
      return Response.json({ error: message }, { status: 404 });
    }
    log.error({ err }, "Failed to delete trust rule");
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// POST /v1/trust-rules/:id/reset — reset default rule
// ---------------------------------------------------------------------------

/**
 * Look up the original base risk and description for a default rule by parsing
 * its pattern against the DEFAULT_COMMAND_REGISTRY.
 *
 * For simple commands (e.g. "ls"), looks up `registry.ls.baseRisk`.
 * For subcommands (e.g. "git push"), looks up `registry.git.subcommands.push.baseRisk`.
 */
function lookupOriginalDefaults(
  pattern: string,
): { risk: string; description: string } | null {
  const parts = pattern.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;

  const command = parts[0];
  const spec = (DEFAULT_COMMAND_REGISTRY as Record<string, unknown>)[command];
  if (!spec || typeof spec !== "object") return null;

  const typed = spec as {
    baseRisk: string;
    reason?: string;
    subcommands?: Record<
      string,
      {
        baseRisk: string;
        reason?: string;
        subcommands?: Record<string, { baseRisk: string; reason?: string }>;
      }
    >;
  };

  // Walk subcommand chain
  let resolved: { baseRisk: string; reason?: string } = typed;
  if (parts.length > 1 && typed.subcommands) {
    let current: typeof typed = typed;
    for (let i = 1; i < parts.length; i++) {
      const sub = current.subcommands?.[parts[i]];
      if (!sub) break;
      current = sub as typeof current;
    }
    resolved = current;
  }

  const description = resolved.reason
    ? `${pattern} \u2014 ${resolved.reason}`
    : `${pattern} (default)`;

  return { risk: resolved.baseRisk, description };
}

export async function handleTrustRulesReset(
  _req: Request,
  ruleId: string,
): Promise<Response> {
  const store = new TrustRuleStore();

  if (!ruleId) {
    return Response.json({ error: "Rule ID is required" }, { status: 400 });
  }

  // Look up the rule first to validate origin
  const existing = store.getById(ruleId);
  if (!existing) {
    return Response.json(
      { error: `Trust rule not found: ${ruleId}` },
      { status: 404 },
    );
  }

  if (existing.origin !== "default") {
    return Response.json(
      { error: "Can only reset default rules" },
      { status: 400 },
    );
  }

  // Determine original risk and description from the command registry
  const originalDefaults = lookupOriginalDefaults(existing.pattern);
  if (!originalDefaults) {
    return Response.json(
      {
        error: `Cannot determine original values for pattern: ${existing.pattern}`,
      },
      { status: 400 },
    );
  }

  try {
    const rule = store.reset(
      ruleId,
      originalDefaults.risk,
      originalDefaults.description,
    );
    invalidateTrustRuleCache();
    return Response.json({ rule });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Internal server error";
    if (message.includes("not found")) {
      return Response.json({ error: message }, { status: 404 });
    }
    log.error({ err }, "Failed to reset trust rule");
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

const TrustRuleRiskSchema = z.enum(["low", "medium", "high"]);

const TrustRuleSchema = z.object({
  id: z.string(),
  tool: z.string(),
  pattern: z.string(),
  risk: TrustRuleRiskSchema,
  description: z.string(),
  origin: z.enum(["default", "user_defined"]),
  userModified: z.boolean(),
  deleted: z.boolean(),
  /**
   * Optional directory scope. When non-null the rule applies only when the
   * tool is invoked from within this directory (or a subdirectory). Null
   * means global.
   */
  scope: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const CreateTrustRuleRequestSchema = z.object({
  tool: z.string().min(1),
  pattern: z.string().min(1),
  risk: TrustRuleRiskSchema,
  description: z.string().min(1),
  scope: z
    .literal("everywhere")
    .optional()
    .describe(
      'Compatibility field. Trust rules apply workspace-wide: the engine matches on tool and pattern only, so a narrower scope cannot be honored and any value other than "everywhere" is rejected rather than stored broader than the consent it records.',
    ),
});

const UpdateTrustRuleRequestSchema = z.object({
  risk: TrustRuleRiskSchema.optional(),
  description: z.string().optional(),
});

const TrustRuleSuggestionSchema = z.object({
  pattern: z.string(),
  risk: z.string(),
  scope: z.string().nullable(),
  description: z.string(),
  scopeOptions: z.array(z.object({ pattern: z.string(), label: z.string() })),
  directoryScopeOptions: z
    .array(z.object({ scope: z.string(), label: z.string() }))
    .nullable()
    .optional(),
});

export const ROUTES: RouteDefinition[] = [
  {
    path: "/trust-rules",
    method: "get",
    operationId: "trustRulesList",
    summary: "List trust rules",
    description:
      "Returns trust rules, filtered to user-relevant rules by default. Pass include_all=true for the full set or origin/tool to filter.",
    tags: ["trust-rules"],
    queryParameters: [
      {
        name: "origin",
        description: "Filter by origin: default or user_defined",
      },
      { name: "tool", description: "Filter by tool name" },
      {
        name: "include_deleted",
        description: '"true" to include soft-deleted rules',
      },
      {
        name: "include_all",
        description: '"true" to disable the user-relevant filter',
      },
    ],
    responseBody: z.object({ rules: z.array(TrustRuleSchema) }),
    auth: "edge-scoped",
    scope: "settings.read",
    scoped: true,
    handler: (req) => handleTrustRulesList(req),
  },
  {
    path: "/trust-rules",
    method: "post",
    operationId: "trustRuleCreate",
    summary: "Create a trust rule",
    tags: ["trust-rules"],
    requestBody: CreateTrustRuleRequestSchema,
    responseStatus: "201",
    responseBody: z.object({ rule: TrustRuleSchema }),
    auth: "edge-scoped",
    scope: "settings.write",
    scoped: true,
    handler: (req) => handleTrustRulesCreate(req),
  },
  {
    path: "/trust-rules/suggest",
    method: "post",
    operationId: "trustRuleSuggest",
    summary: "Generate a trust-rule suggestion",
    description:
      "LLM-backed suggestion for a rule matching the given tool invocation. Returns 503 when the daemon suggestion relay is unavailable.",
    tags: ["trust-rules"],
    requestBody: SuggestRequestSchema,
    responseBody: z.object({ suggestion: TrustRuleSuggestionSchema }),
    auth: "edge-scoped",
    scope: "settings.write",
    scoped: true,
    handler: (req) => handleTrustRulesSuggest(req),
  },
  {
    path: "/trust-rules/{rule_id}",
    method: "patch",
    operationId: "trustRuleUpdate",
    summary: "Update a trust rule",
    description:
      "Updates risk and/or description. Updating a default-origin rule marks it userModified.",
    tags: ["trust-rules"],
    pathParameters: [{ name: "rule_id", description: "The trust rule id" }],
    requestBody: UpdateTrustRuleRequestSchema,
    responseBody: z.object({ rule: TrustRuleSchema }),
    auth: "edge-scoped",
    scope: "settings.write",
    scoped: true,
    handler: (req, params) => handleTrustRulesUpdate(req, params[0]!),
  },
  {
    path: "/trust-rules/{rule_id}",
    method: "delete",
    operationId: "trustRuleDelete",
    summary: "Delete a trust rule",
    description:
      "Soft-deletes the rule. Default-origin rules can be reset later.",
    tags: ["trust-rules"],
    pathParameters: [{ name: "rule_id", description: "The trust rule id" }],
    responseBody: z.object({ success: z.boolean() }),
    auth: "edge-scoped",
    scope: "settings.write",
    scoped: true,
    handler: (req, params) => handleTrustRulesDelete(req, params[0]!),
  },
  {
    path: "/trust-rules/{rule_id}/reset",
    method: "post",
    operationId: "trustRuleReset",
    summary: "Reset a default trust rule",
    description:
      "Restores a default-origin rule to its registry risk and description, clearing userModified and deleted.",
    tags: ["trust-rules"],
    pathParameters: [{ name: "rule_id", description: "The trust rule id" }],
    responseBody: z.object({ rule: TrustRuleSchema }),
    auth: "edge-scoped",
    scope: "settings.write",
    scoped: true,
    handler: (req, params) => handleTrustRulesReset(req, params[0]!),
  },
];
