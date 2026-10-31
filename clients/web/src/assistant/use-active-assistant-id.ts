/**
 * The active assistant id — always defined within the web bundle.
 *
 * The serving shell resolves the assistant and stamps the store before the
 * first render (the cloud platform's own SPA stamps its shell at boot and
 * the `/assistant/` projection replaces it as it settles), so every reader
 * can treat the id as `string` — the store's assistant is non-optional and
 * so is the id it carries.
 */

import { useResolvedAssistantStore } from "@/stores/resolved-assistant-store";

export function useActiveAssistantId(): string {
  return useResolvedAssistantStore.use.assistant().assistantId;
}
