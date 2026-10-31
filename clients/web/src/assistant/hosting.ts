import type { Remote } from "@mycadet/local-mode/contract";

import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

/**
 * The active assistant's remote — the store's active row's `cloud`, which
 * the projection normalizes: the lockfile entry's hosting kind for
 * lockfile rows, `"cloud"` for rows absent from the lockfile (they exist
 * only in the cloud-served world). The web bundle exists only for a
 * resolved assistant, so there is no resolving answer.
 */
export function useAssistantHosting(): Remote {
  return (
    (useResolvedAssistantsStore((s) =>
      s.assistants.find((a) => a.id === s.activeAssistantId)?.cloud,
    ) ?? "cloud") as Remote
  );
}

/** The active assistant's remote is "cloud". */
export function useActiveAssistantIsCloudHosted(): boolean {
  return useAssistantHosting() === "cloud";
}

/** The active assistant's remote is one of the self-hosted ones. */
export function useActiveAssistantIsSelfHosted(): boolean {
  return useAssistantHosting() !== "cloud";
}
