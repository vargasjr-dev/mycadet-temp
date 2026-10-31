import type { Remote } from "@mycadet/local-mode/contract";

import { useResolvedAssistantStore } from "@/stores/resolved-assistant-store";

/**
 * The active assistant's remote — the served entry's `cloud`, stamped by
 * the shell or the `/assistant/` projection. The web bundle exists only
 * for a resolved assistant, so there is no resolving answer.
 */
export function useAssistantHosting(): Remote {
  return useResolvedAssistantStore((s) => s.assistant?.cloud ?? "cloud");
}

/** The active assistant's remote is "cloud". */
export function useActiveAssistantIsCloudHosted(): boolean {
  return useAssistantHosting() === "cloud";
}

/** The active assistant's remote is one of the self-hosted ones. */
export function useActiveAssistantIsSelfHosted(): boolean {
  return useAssistantHosting() !== "cloud";
}
