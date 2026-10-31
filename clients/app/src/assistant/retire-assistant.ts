import { retireAssistantById } from "@app/assistant/api";
import {
  clearSelectedAssistantId,
  readSelectedAssistantId,
} from "@app/assistant/selected-assistant-storage";

export type RetireAssistantResult = { ok: true } | { ok: false; error: string };

/**
 * Permanently retire an assistant through the scoped surface's one retire
 * endpoint, for every entry type: the request is same-origin, and the serving
 * host decides how to honor it (the desktop proxy and the dev server run the
 * host CLI for on-machine entries; the cloud retires platform rows). The
 * bundle never branches on entry type.
 *
 * A 404 means the assistant is already gone — the same success web's
 * retire-service granted, so a stale chooser row still clears instead of
 * wedging the dialog on an error nothing can fix. Retiring the stored
 * selection drops it, mirroring web's active-id cleanup: without that, the
 * shell could admit a retired assistant with nothing behind it.
 */
export async function retireAssistant(
  assistantId: string,
): Promise<RetireAssistantResult> {
  const result = await retireAssistantById(assistantId);
  if (!result.ok && result.status !== 404) {
    return { ok: false, error: result.error.detail };
  }
  if (readSelectedAssistantId() === assistantId) {
    clearSelectedAssistantId();
  }
  return { ok: true };
}
