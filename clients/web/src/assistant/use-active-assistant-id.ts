/**
 * The active assistant id — always defined within the web bundle.
 *
 * The serving shell resolves the assistant and stamps the roster before
 * the first render, so every route can treat the id as `string`. This
 * hook turns that runtime guarantee into a type guarantee — and throws
 * if the id is somehow missing, which is the bug we want loud.
 */

import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

export function useActiveAssistantId(): string {
  const id = useResolvedAssistantsStore.use.activeAssistantId();
  if (!id) {
    throw new Error(
      "useActiveAssistantId() called outside ActiveAssistantGate — " +
        "either mount the route under <ActiveAssistantGate> or read the " +
        "raw store via useResolvedAssistantsStore.use.activeAssistantId().",
    );
  }
  return id;
}
