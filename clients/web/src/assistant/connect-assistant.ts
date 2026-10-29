/**
 * Assistant connection — the interactive "switch to that assistant"
 * operation for PLATFORM rows, shared by notification taps.
 *
 * Connecting to lockfile entries is app-only: the app bundle owns those
 * connections (and their pairing/recovery choreography), so the web's only
 * connect is the platform row's selection write. There is no session probe:
 * the write itself is session-scoped, and the server answers an
 * unauthenticated attempt with 401.
 */
import { setSelectedAssistant } from "@/assistant/selection";

export async function connectCloudAssistant(
  assistantId: string,
): Promise<void> {
  await setSelectedAssistant(assistantId);
}
