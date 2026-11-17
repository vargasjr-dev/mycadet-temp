/**
 * The active assistant id — always defined within the web bundle.
 *
 * The serving shell resolves the assistant and stamps the id before the
 * first render (the cloud platform's own SPA stamps its shell at boot and
 * the projection replaces it as it settles), so every reader can treat the
 * id as `string` — pre-resolution the hook observes the empty id.
 */

import { useResolvedAssistantStore } from "@/stores/resolved-assistant-store";

export function useActiveAssistantId(): string {
  return useResolvedAssistantStore.use.assistantId();
}
