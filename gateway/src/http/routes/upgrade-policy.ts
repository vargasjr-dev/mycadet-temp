/**
 * Upgrade-policy CRUD endpoints for the gateway.
 *
 * The assistant's automatic-upgrade schedule lives in the singleton
 * `upgradePolicy` row (canonical JSON of the policy shape). GET answers the
 * defaults when the row is absent; a corrupt stored payload is answered with
 * the defaults rather than erroring — a bad write can only ever cost the
 * policy, not the runtime.
 */

import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { getGatewayDb } from "../../db/connection.js";
import { upgradePolicy } from "../../db/schema.js";
import { getLogger } from "../../logger.js";

const log = getLogger("upgrade-policy");

// ---------------------------------------------------------------------------
// Shared validation
// ---------------------------------------------------------------------------

const HH_MM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const UpgradePolicyWindowSchema = z
  .object({
    start: z.string().regex(HH_MM_RE, "must be HH:MM (UTC)"),
    end: z.string().regex(HH_MM_RE, "must be HH:MM (UTC)"),
  })
  .strict();

export const UpgradePolicyScheduleSchema = z
  .object({
    frequency: z.enum(["daily", "weekly", "monthly"]),
    // 0 = Monday … 6 = Sunday — the backend index order the settings
    // UI's day buttons have always sent.
    days_of_week: z.array(z.number().int().min(0).max(6)),
    days_of_month: z.array(z.number().int().min(1).max(31)),
    window: UpgradePolicyWindowSchema,
  })
  .strict();

export const UpgradePolicySchema = z
  .object({
    enabled: z.boolean(),
    timezone: z.string().max(64),
    schedule: UpgradePolicyScheduleSchema,
  })
  .strict();

export type UpgradePolicy = z.infer<typeof UpgradePolicySchema>;

/** The policy every assistant gets before the user has touched the form. */
export function defaultUpgradePolicy(): UpgradePolicy {
  return {
    enabled: true,
    timezone: "UTC",
    schedule: {
      frequency: "weekly",
      days_of_week: [0],
      days_of_month: [],
      window: { start: "06:00", end: "08:00" },
    },
  };
}

// ---------------------------------------------------------------------------
// GET /v1/upgrade-policy
// ---------------------------------------------------------------------------

export function createUpgradePolicyGetHandler() {
  return async (_req: Request): Promise<Response> => {
    try {
      const db = getGatewayDb();
      const row = db
        .select()
        .from(upgradePolicy)
        .where(eq(upgradePolicy.id, 1))
        .get();

      if (!row) {
        return Response.json(defaultUpgradePolicy());
      }

      let parsedPolicy: unknown;
      try {
        parsedPolicy = JSON.parse(row.policy);
      } catch {
        log.error("Stored upgrade policy is not valid JSON — answering defaults");
        return Response.json(defaultUpgradePolicy());
      }
      const parsed = UpgradePolicySchema.safeParse(parsedPolicy);
      if (!parsed.success) {
        log.error({ err: parsed.error }, "Stored upgrade policy failed validation — answering defaults");
        return Response.json(defaultUpgradePolicy());
      }

      return Response.json(parsed.data);
    } catch (err) {
      log.error({ err }, "Failed to read upgrade policy");
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  };
}

// ---------------------------------------------------------------------------
// PUT /v1/upgrade-policy
// ---------------------------------------------------------------------------

export function createUpgradePolicyPutHandler() {
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

    const parsed = UpgradePolicySchema.safeParse(body);
    if (!parsed.success) {
      return Response.json(
        {
          error: "Invalid upgrade policy",
          details: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
        { status: 400 },
      );
    }

    try {
      const db = getGatewayDb();
      const policy = JSON.stringify(parsed.data);
      db.insert(upgradePolicy)
        .values({ id: 1, policy })
        .onConflictDoUpdate({
          target: upgradePolicy.id,
          set: { policy, updatedAt: sql`(datetime('now'))` },
        })
        .run();

      return Response.json(parsed.data);
    } catch (err) {
      log.error({ err }, "Failed to save upgrade policy");
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  };
}
