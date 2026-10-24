/**
 * `assistant_status` SSE event.
 *
 * Server → client status announcement carrying the daemon `version`.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@mycadet/assistant-api`.
 */

import { z } from "zod";

export const AssistantStatusEventSchema = z.object({
  type: z.literal("assistant_status"),
  version: z.string().optional(),
});

export type AssistantStatusEvent = z.infer<typeof AssistantStatusEventSchema>;
