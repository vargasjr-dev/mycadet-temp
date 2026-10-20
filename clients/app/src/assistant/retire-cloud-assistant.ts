import { retireAssistantById } from "@app/assistant/api";
import {
  clearSelectedAssistantId,
  readSelectedAssistantId,
} from "@app/assistant/selected-assistant-storage";

export type RetireCloudAssistantResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Permanently retire a cloud assistant through the cloud's retire route.
 *
 * A 404 means the assistant is already gone — the same success web's
 * retire-service grants, so a stale chooser row still clears instead of
 * wedging the dialog on an error nothing can fix. Retiring the stored
 * selection drops it, mirroring web's active-id cleanup: without that, the
 * shell could admit a retired assistant with nothing behind it.
 */
export async function retireCloudAssistant(
  assistantId: string,
): Promise<RetireCloudAssistantResult> {
  const result = await retireAssistantById(assistantId);
  if (!result.ok && result.status !== 404) {
    return { ok: false, error: result.error.detail };
  }
  if (readSelectedAssistantId() === assistantId) {
    clearSelectedAssistantId();
  }
  return { ok: true };
}
