import type { LockfileAssistant } from "@mycadet/local-mode/contract";

import { useResolvedAssistantStore } from "@/stores/resolved-assistant-store";

/**
 * Test-only setup for the most common hook-test seed: the resolved store
 * holds one plain local assistant whose gateway listens on the default
 * port. Idempotent per id — call it in a test body or a `beforeEach`.
 */
export function useSetupLocalAssistant(
  assistantId: string,
): LockfileAssistant {
  const entry: LockfileAssistant = {
    cloud: "local",
    assistantId,
    port: 7830,
  };
  useResolvedAssistantStore.getState().setAssistant(entry);
  return entry;
}
