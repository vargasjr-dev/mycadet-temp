import { z } from "zod";

import type { GatewayRouteDefinition } from "./types.js";

/**
 * OpenAPI route metadata for the upgrade-policy API — the assistant's
 * automatic-upgrade schedule (enabled + timezone + schedule{frequency, days,
 * window}), stored gateway-side.
 *
 * These schemas are the codegen source of truth for the generated gateway
 * SDK (see scripts/generate-openapi.ts). Clients consume the operations
 * through the SDK, which targets the assistant-scoped
 * `/v1/assistants/{assistant_id}/upgrade-policy` route variant registered
 * in `index.ts` alongside the flat path documented here.
 *
 * The handlers live in `upgrade-policy.ts`. This module is intentionally
 * schema-only so the codegen script can import it without pulling in DB
 * dependencies.
 */

const HH_MM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const UpgradePolicyWindowSchema = z
  .object({
    start: z.string().regex(HH_MM_RE, "must be HH:MM (UTC)"),
    end: z.string().regex(HH_MM_RE, "must be HH:MM (UTC)"),
  })
  .strict();

const UpgradePolicyScheduleSchema = z
  .object({
    frequency: z.enum(["daily", "weekly", "monthly"]),
    // 0 = Monday … 6 = Sunday — the backend index order the settings
    // UI's day buttons have always sent.
    days_of_week: z.array(z.number().int().min(0).max(6)),
    days_of_month: z.array(z.number().int().min(1).max(31)),
    window: UpgradePolicyWindowSchema,
  })
  .strict();

const UpgradePolicySchema = z
  .object({
    enabled: z.boolean(),
    timezone: z.string().max(64),
    schedule: UpgradePolicyScheduleSchema,
  })
  .strict();

export const ROUTES: GatewayRouteDefinition[] = [
  {
    path: "/upgrade-policy",
    method: "get",
    operationId: "upgradePolicyGet",
    summary: "Get the assistant's automatic-upgrade schedule",
    description:
      "Returns the stored policy, or the defaults (enabled, weekly, " +
      "Mon 06:00–08:00 UTC) when none has been saved yet.",
    tags: ["settings"],
    responseBody: UpgradePolicySchema,
  },
  {
    path: "/upgrade-policy",
    method: "put",
    operationId: "upgradePolicyPut",
    summary: "Save the assistant's automatic-upgrade schedule",
    description: "Full replace — the request body is the complete policy.",
    tags: ["settings"],
    requestBody: UpgradePolicySchema,
    responseBody: UpgradePolicySchema,
  },
];
