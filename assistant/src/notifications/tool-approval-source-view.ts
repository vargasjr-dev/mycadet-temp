/**
 * The tool-approval source view lives in its own module so the notifications
 * type graph and the guardian projection code can import it without forming
 * a cycle between `notifications/types.ts` and `guardian-question-mode.ts`.
 */
import { z } from "zod";

/**
 * Display-ready source reference for a tool-approval card, shared by every
 * renderer (the Cadet Surface card and the channel adapters) so the
 * chat-id/permalink derivation lives in exactly one place. Declared as a
 * Zod schema because the broadcaster carries the projected view on
 * `ChannelDeliveryPayload` (computed once per broadcast, never re-derived
 * per channel).
 *
 * Core fields (`channel`, `chatId`, `permalink`) are channel-neutral.
 * Channel-scoped display facts are named for their channel (`isSlackDm`)
 * and gated on `channel` — renderers branch on them for richer labels but
 * must degrade to the neutral fields for every other channel, so a new
 * channel renders correctly with no projection changes.
 */
export const ToolApprovalSourceViewSchema = z.object({
  /** Channel the request originated from (e.g. `"slack"`). */
  channel: z.string(),
  /** Channel-native chat id, when the payload carries one. */
  chatId: z.string().optional(),
  /** Display name of the originating chat, when ingress captured one. */
  chatName: z.string().optional(),
  /** Whether the source chat is a Slack direct message (`false` for other channels). */
  isSlackDm: z.boolean(),
  /** Link to the originating message/thread, when derivable. */
  permalink: z.string().optional(),
});

export type ToolApprovalSourceView = z.infer<
  typeof ToolApprovalSourceViewSchema
>;
