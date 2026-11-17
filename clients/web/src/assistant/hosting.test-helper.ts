import { useResolvedAssistantStore } from "@/stores/resolved-assistant-store";

/**
 * Stamp the store with a resolved assistant id — the test seam for a
 * surface running under a serving host. The store is remote-agnostic: any
 * host (self-hosted shell, gateway, the cloud platform's own projection)
 * stamps exactly this, so tests aim it the same way.
 */
export function setResolvedAssistant(assistantId = "asst-local"): void {
  useResolvedAssistantStore.getState().setAssistantId(assistantId);
}
