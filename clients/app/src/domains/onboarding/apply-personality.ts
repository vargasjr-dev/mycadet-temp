/**
 * Applies the "Create my personality" slider choices to the assistant.
 *
 * SPIKE — research-onboarding flow.
 *
 * The personality step collects five 0–100 trait sliders. On continue we hand
 * them to the real hatched assistant as a system-message that asks it to
 * rewrite its own identity files (IDENTITY.md / SOUL.md) in a voice matching
 * the new personality (see `@/assistant/personality-rewrite` for the message
 * and settle logic, shared with the About Assistant personality page). The
 * user's profile (users/guardian.md) is left untouched.
 *
 * Like the research turn (`research-runner.ts`), this runs on a dedicated
 * throwaway side conversation: we await hatch readiness, mint a conversation,
 * post the prompt, and let the rewrite turn settle. Talks to the daemon through
 * the generated SDK directly (`@/domains/chat/api/*` is import-banned from
 * onboarding).
 *
 * The thread is minted `conversationType: "background"`, which keeps it out of
 * the daemon's default `standard` conversation list: it never enters Recents
 * and is never selectable as the landing conversation. The prompt posts hidden,
 * so the thread's only renderable content is the assistant's reply. The archive
 * below is best-effort cleanup.
 *
 * Best-effort and fire-and-forget: a failure here must never block or surface
 * in the onboarding flow. Every error is swallowed (reported via captureError).
 */

import {
  buildPersonalityMessage,
  shouldSettlePersonalityPoll,
} from "@web/assistant/personality-rewrite";
import {
  completeSliderValues,
  savePersonalitySliders,
} from "@web/assistant/personality-sliders";
import {
  archiveAssistantConversation,
  createAssistantConversation,
  listAssistantMessages,
  postAssistantMessage,
} from "@app/gateway/daemon";
import { captureError } from "@mycadet/design-library/utils/capture-error";
import { buildSideConversationMessageBody } from "@web/lib/side-conversation-message";
import { latestAssistantText } from "@web/utils/latest-assistant-text";

export {
  buildPersonalityMessage,
  shouldSettlePersonalityPoll,
} from "@web/assistant/personality-rewrite";

/** Poll cadence + ceiling while waiting for the rewrite turn to land. */
const POLL_INTERVAL_MS = 1500;
const MAX_POLL_MS = 120_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface ApplyPersonalityOptions {
  /** Resolves with the hatched assistant id once it's healthy. */
  awaitAssistantId: () => Promise<string>;
  /** The five slider values, keyed by axis id (see `PERSONALITY_AXIS_IDS`). */
  values: Record<string, number>;
  /** The user's name, woven into the system-message. */
  userName?: string;
  /**
   * The assistant name picked on the face screen. Passed through so the
   * rewrite writes the chosen name instead of trusting its (possibly stale)
   * system-prompt copy of IDENTITY.md.
   */
  assistantName?: string;
}

/**
 * Apply the personality on a throwaway side conversation. Resolves once the
 * conversation has been archived (or immediately on any failure); never throws.
 */
export async function applyPersonality({
  awaitAssistantId,
  values,
  userName,
  assistantName,
}: ApplyPersonalityOptions): Promise<void> {
  let assistantId: string | undefined;
  let conversationId: string | undefined;
  try {
    assistantId = await awaitAssistantId();

    const conversation = await createAssistantConversation(assistantId, {
      conversationType: "background",
      title: "Updating personality",
    });
    conversationId = conversation.ok ? conversation.data.id : undefined;
    if (!conversation.ok || !conversationId) {
      return;
    }

    const body = buildSideConversationMessageBody({
      conversationId,
      content: buildPersonalityMessage(values, userName, assistantName),
      transport: "cadet",
    });
    const posted = await postAssistantMessage(assistantId, body);
    if (!posted.ok) {
      return;
    }

    // Persist the raw dial positions as the workspace sidecar the About
    // Assistant personality page and the overview's signature read: the prose
    // rewrite alone would lose them. Best-effort, like the rest of the flow.
    await savePersonalitySliders(assistantId, completeSliderValues(values));

    // Let the rewrite turn run before the archive: archiving mid-turn could
    // drop the identity edits, and the chat handoff awaits this promise
    // so the first greeting must not start until the identity files are
    // written. Settle on the daemon's turn-completion flag (see
    // `shouldSettlePersonalityPoll`).
    const deadline = Date.now() + MAX_POLL_MS;
    let lastText = "";
    let stableReads = 0;
    let sawProcessing = false;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      const listed = await listAssistantMessages(assistantId, conversationId);
      const text = latestAssistantText(
        listed.ok ? listed.data.messages : [],
      );
      if (text) {
        stableReads = text === lastText ? stableReads + 1 : 0;
        lastText = text;
      }
      if (listed.ok && listed.data.processing === true) {
        sawProcessing = true;
      }
      if (
        shouldSettlePersonalityPoll({
          processing: listed.ok ? listed.data.processing : undefined,
          sawProcessing,
          hasReply: text.length > 0,
          stableReads,
        })
      ) {
        break;
      }
    }
  } catch (err) {
    captureError(err, { context: "research_onboarding_personality" });
  } finally {
    // Best-effort cleanup of the throwaway thread. The `background` mint (see
    // the module header) is what keeps it hidden, not this call.
    if (assistantId && conversationId) {
      try {
        await archiveAssistantConversation(assistantId, conversationId);
      } catch (err) {
        captureError(err, {
          context: "research_onboarding_personality_archive",
        });
      }
    }
  }
}
