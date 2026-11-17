import { useResolvedAssistantStore } from "@/stores/resolved-assistant-store";

/**
 * Test-only setup for the most common hook-test seed: the resolved store
 * holds one assistant id. Idempotent per id — call it in a test body or a
 * `beforeEach`.
 */
export function useSetupLocalAssistant(assistantId: string): string {
  useResolvedAssistantStore.getState().setAssistantId(assistantId);
  return assistantId;
}
