/**
 * `cloud_disconnected` SSE event.
 *
 * Emitted by the cloud-disconnect route after stored platform
 * credentials are deleted, notifying connected clients that the cloud
 * connection is gone.
 *
 * Canonical wire-contract source. Daemon code imports the type
 * directly from this file; external consumers import via
 * `@mycadet/assistant-api`.
 */

import { z } from "zod";

export const CloudDisconnectedEventSchema = z.object({
  type: z.literal("cloud_disconnected"),
});

export type CloudDisconnectedEvent = z.infer<
  typeof CloudDisconnectedEventSchema
>;
