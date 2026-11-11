/**
 * Channel-neutral shapes for guardian approval-card source references,
 * shared by the registry (`runtime/approval-source-link.ts`) and the
 * per-channel resolvers it dispatches to. They live in their own module so
 * a resolver can type its inputs without importing the registry — the
 * registry imports resolvers, and that edge must stay one-directional.
 */
import type { ExternalSourceLink } from "../messaging/channel-binding-schema.js";

/**
 * Reference to the channel message/conversation that triggered an approval,
 * shaped as the `guardian.question` context-payload fields it becomes.
 */
export interface ApprovalSourceReference {
  /** Channel-native chat/conversation id the request originated from. */
  sourceChatId: string;
  /**
   * Display name of the originating chat, when ingress captured one (a
   * Slack channel's name, without the `#`). Renderers prefer it over the
   * raw chat id and fall back when absent (DMs, pre-capture rows).
   */
  sourceChatName?: string;
  /** Deep link to the originating message/thread, when derivable. */
  sourceLink?: ExternalSourceLink;
}

/**
 * Exact provenance of the triggering message, stamped onto the trust
 * context at ingress and threaded through the turn to the producer. When
 * present, resolvers use it directly instead of reconstructing the
 * reference from persisted rows — reconstruction is the fallback for
 * turns without a stamped ingress context (voice, retries).
 *
 * Field names match `TrustContext` / `ToolContext`, so producers pass
 * their context object (or a shorthand literal) straight through.
 */
export interface ApprovalSourceHint {
  /** Chat/conversation id the requester is interacting through. */
  requesterChatId?: string | null;
  /** Channel-native id of the message that started the turn. */
  sourceMessageId?: string;
  /** Channel-native thread id of that message, when threaded. */
  sourceThreadId?: string;
}
