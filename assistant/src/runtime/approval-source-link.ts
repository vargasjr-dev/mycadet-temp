/**
 * Channel-neutral source references for guardian approval cards.
 *
 * When a channel actor triggers a tool that needs guardian approval, the
 * approval card should link the guardian back to the originating
 * conversation. The mechanism is split into four layers with strict
 * ownership, mirroring the `sourceLink` contract on conversation channel
 * bindings:
 *
 * 1. **Contract + registry (this module).** Owns the neutral shapes
 *    ({@link ApprovalSourceReference}, {@link ApprovalSourceHint}) and
 *    dispatches by source channel. Knows which channels have resolvers;
 *    knows nothing about any channel's id or URL formats.
 * 2. **Per-channel resolvers** (`messaging/providers/<channel>/
 *    approval-source.ts`). Own all channel-format knowledge — how to turn
 *    the hint and/or persisted rows into a chat id and deep link. Called
 *    only through this registry.
 * 3. **Neutral projection** (`buildToolApprovalSourceView` in
 *    `notifications/guardian-question-mode.ts`). Shapes the payload fields
 *    into display-ready facts once per broadcast. Channel-scoped display
 *    facts it carries are explicitly named as such (`isSlackDm`).
 * 4. **Per-destination renderers** (`notifications/approval-card-data.ts`
 *    for the in-app Surface card, `notifications/adapters/<channel>` for
 *    channel cards). Format the projected view for their surface; they
 *    never parse channel-native ids or build URLs.
 *
 * Producers spread the resolved reference into the `guardian.question`
 * context payload with a single call. Channels without a registered
 * resolver contribute no reference — their cards render without a link. To
 * light up a new channel (e.g. Discord): implement layer 2 in
 * `messaging/providers/<channel>/approval-source.ts` and register it in
 * {@link SOURCE_RESOLVERS}; layers 1, 3, and 4 need no changes.
 */

import { resolveSlackApprovalSource } from "../messaging/providers/slack/approval-source.js";
import { getLogger } from "../util/logger.js";
import {
  type ApprovalSourceHint,
  type ApprovalSourceReference,
} from "./approval-source-types.js";

const log = getLogger("approval-source-link");

const SOURCE_RESOLVERS: Partial<
  Record<
    string,
    (
      conversationId: string,
      hint: ApprovalSourceHint | undefined,
    ) => ApprovalSourceReference | null
  >
> = {
  slack: resolveSlackApprovalSource,
};

/**
 * Best-effort lookup of the source reference for an approval originating
 * from `sourceChannel`. Returns `null` for channels without a resolver or
 * when the resolver cannot derive a reference. Never throws — approval
 * creation must not fail because a card link could not be built.
 */
export function resolveApprovalSourceReference(
  sourceChannel: string,
  conversationId: string,
  hint?: ApprovalSourceHint,
): ApprovalSourceReference | null {
  const resolver = SOURCE_RESOLVERS[sourceChannel];
  if (!resolver) {
    return null;
  }
  try {
    return resolver(conversationId, hint);
  } catch (err) {
    log.warn(
      { err, sourceChannel, conversationId },
      "Failed to resolve approval source reference",
    );
    return null;
  }
}
