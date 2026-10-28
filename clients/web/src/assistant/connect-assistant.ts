/**
 * Assistant connection — the interactive "switch to that assistant"
 * operation for PLATFORM rows, shared by notification taps.
 *
 * Connecting to lockfile entries is app-only: the app bundle owns those
 * connections (and their pairing/recovery choreography), so the web's only
 * connect is the platform row's session-gated selection. The selection write
 * IS the session commit — the auth store carries no session state to stamp.
 */
import { getSession } from "@/lib/auth/allauth-client";
import { setSelectedAssistant } from "@/assistant/selection";

export async function connectCloudAssistant(
  assistantId: string,
): Promise<void> {
  const result = await getSession();
  if (!result.ok || !result.data.user) {
    throw new Error("Platform authentication required");
  }
  await setSelectedAssistant(assistantId);
}
