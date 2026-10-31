/**
 * The active assistant id — always defined within the web bundle.
 *
 * The serving shell resolves the assistant and stamps the store before
 * the first render, so every route can treat the id as `string`. This
 * hook turns that runtime guarantee into a type guarantee — and throws
 * if the assistant is somehow missing, which is the bug we want loud.
 */

import { useResolvedAssistantStore } from "@/stores/resolved-assistant-store";

export function useActiveAssistantId(): string {
  const id = useResolvedAssistantId();
  if (!id) {
    throw new Error(
      "useActiveAssistantId() found no resolved assistant — the web " +
        "bundle exists only for a resolved assistant, and the serving " +
        "shell stamps it before the first render. A missing id is the bug.",
    );
  }
  return id;
}

/**
 * The reactive, nullable read. For consumers mounted before the resolver
 * has decided — the always-mounted root hooks, standalone windows — where
 * a pre-stamp render is legitimate and null means "not yet stamped".
 */
export function useResolvedAssistantId(): string | null {
  return useResolvedAssistantStore.use.assistant()?.assistantId ?? null;
}
