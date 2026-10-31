import type { Remote } from "@mycadet/local-mode/contract";

import { getLockfileAssistant } from "@/lib/local-mode";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

/**
 * The active assistant's remote. The answer is the lockfile entry's
 * `cloud` field — the hosting kind recorded when the assistant was
 * hatched or paired. Rows absent from the lockfile exist only in the
 * cloud-served world (the cloud platform keeps no locally-synthesized
 * entry), so they answer `"cloud"`. The web bundle exists only for a
 * resolved assistant, so there is no resolving answer.
 */
export function useAssistantHosting(): Remote {
  const activeId = useResolvedAssistantsStore((s) => s.activeAssistantId);
  const entry = activeId ? getLockfileAssistant(activeId) : undefined;
  return entry ? entry.cloud : "cloud";
}

/** The active assistant's remote is "cloud". */
export function useActiveAssistantIsCloudHosted(): boolean {
  return useAssistantHosting() === "cloud";
}

/** The active assistant's remote is one of the self-hosted ones. */
export function useActiveAssistantIsSelfHosted(): boolean {
  return useAssistantHosting() !== "cloud";
}
