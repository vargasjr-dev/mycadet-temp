/**
 * `show_platform_login` SSE event.
 *
 * Emitted by the cloud-connect route when no cloud credentials are
 * stored yet, signalling connected clients to surface the cloud login UI.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@mycadet/assistant-api`.
 */

import { z } from "zod";

export const ShowCloudLoginEventSchema = z.object({
  type: z.literal("show_platform_login"),
});

export type ShowCloudLoginEvent = z.infer<typeof ShowCloudLoginEventSchema>;
