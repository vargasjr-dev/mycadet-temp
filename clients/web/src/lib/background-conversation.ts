import {
  conversationsByIdDelete,
  conversationsPost,
} from "@/generated/daemon/sdk.gen";
import { extractErrorMessage } from "@/utils/api-errors";

export type CreateBackgroundConversationResult =
  | { ok: true; conversationId: string }
  | { ok: false; error: string };

export interface CreateBackgroundConversationArgs {
  assistantId: string;
  /**
   * Copy to show when the failure carried no message of its own. Supplied by
   * the caller because the error is displayed by a feature surface and this
   * seam sits below any locale namespace a domain owns.
   */
  fallback: string;
  /**
   * Persisted as a user-set title. The auto-titler leaves those alone, so a
   * checklist launch can name the thread from the start instead of leaving
   * "New conversation" in the sidebar until the first turn finishes.
   */
  title?: string;
}

/**
 * Create the conversation a background turn will run in.
 *
 * `standard` (the daemon's default) on purpose: this is a conversation the
 * user is meant to be able to open, unlike the `background` rows the
 * onboarding and identity flows create for work nobody should ever see.
 * Callers that already know the thread's name pass `title`.
 *
 * Never throws: a transport failure comes back as `ok: false` so a caller's
 * result contract holds on every path.
 */
export async function createBackgroundConversation({
  assistantId,
  fallback,
  title,
}: CreateBackgroundConversationArgs): Promise<CreateBackgroundConversationResult> {
  try {
    const { data, error, response } = await conversationsPost({
      path: { assistant_id: assistantId },
      body: title ? { title } : {},
      throwOnError: false,
    });
    const conversationId = data?.id;
    if (!response?.ok || !conversationId) {
      return {
        ok: false,
        error: extractErrorMessage(error, response, fallback),
      };
    }
    return { ok: true, conversationId };
  } catch (error) {
    return {
      ok: false,
      error: extractErrorMessage(error, undefined, fallback),
    };
  }
}

/**
 * Give back a background conversation nothing will ever use.
 *
 * Only for the window between creating a conversation and the caller deciding
 * it has no owner: an empty row left behind sits in the sidebar as a
 * conversation the user never started. A conversation that has been linked to
 * something, or that carries a message, belongs to whoever linked it.
 *
 * Never throws and never reports: the caller has already failed at something
 * more important, and a leftover empty conversation costs one stray row.
 */
export async function discardBackgroundConversation(
  assistantId: string,
  conversationId: string,
): Promise<void> {
  try {
    await conversationsByIdDelete({
      path: { assistant_id: assistantId, id: conversationId },
      throwOnError: false,
    });
  } catch {
    // Best effort by contract.
  }
}
