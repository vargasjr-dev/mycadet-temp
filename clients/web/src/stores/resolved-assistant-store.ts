/**
 * The resolved assistant store — the one assistant this web surface serves.
 *
 * The web bundle exists only for a resolved assistant: the shell that mounts
 * it (the app bundle's iframe, the gateway-served host page) has already
 * resolved the assistant and stamps the store before the first render —
 * locally from the served synthesis, in the gateway-served world from the
 * same synthesis the host owns. The `/assistant/` projection
 * (`assistant/queries.ts`) re-stamps the entry with platform-answered
 * identity as it settles; there is no roster, no selection, and no
 * hydration question. The store IS the single assistant fact, typed by the
 * same `LockfileAssistant` the rest of the stack speaks, and the assistant
 * is non-optional: readers can rely on the entry existing.
 *
 * The one state where the entry is a shell (`UNRESOLVED_ASSISTANT`) is the
 * cloud platform's own SPA before its projection lands: the platform serves
 * this bundle for account/auth surfaces where no assistant has been
 * resolved yet, and the id only becomes real when the projection stamps it.
 * Assistant-scoped surfaces read the id reactively, so they re-render with
 * the real identity in the same tick the projection lands; pre-resolution
 * they observe the empty id and skip their requests.
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";
import type { LockfileAssistant } from "@/runtime/local-mode-host";
import { getServedLockfile } from "@/lib/local-mode";

/** The boot entry for a surface whose serving host fronted no assistant. */
export const UNRESOLVED_ASSISTANT: LockfileAssistant = {
  cloud: "cloud",
  assistantId: "",
};

/**
 * The assistant this surface serves at boot: the served synthesis when the
 * host stamped one, else the unresolved cloud shell the projection replaces.
 */
function initialAssistant(): LockfileAssistant {
  return getServedLockfile().assistants[0] ?? UNRESOLVED_ASSISTANT;
}

interface ResolvedAssistantState {
  /** The one assistant this web surface serves. */
  assistant: LockfileAssistant;
}

interface ResolvedAssistantActions {
  /**
   * Stamp (or replace) the served assistant. Replacing the shell
   * (`resetAssistant`) is the projection's job and the test reset's; a
   * production surface never clears the store.
   */
  setAssistant: (entry: LockfileAssistant) => void;
  /** Back to {@link UNRESOLVED_ASSISTANT} — the test reset. */
  resetAssistant: () => void;
}

const useResolvedAssistantStoreBase = create<
  ResolvedAssistantState & ResolvedAssistantActions
>()((set) => ({
  assistant: initialAssistant(),
  setAssistant: (entry) => set({ assistant: entry }),
  resetAssistant: () => set({ assistant: UNRESOLVED_ASSISTANT }),
}));

export const useResolvedAssistantStore = createSelectors(
  useResolvedAssistantStoreBase,
);

/** Non-reactive read of the served assistant. */
export function getResolvedAssistant(): LockfileAssistant {
  return useResolvedAssistantStoreBase.getState().assistant;
}

/** Non-reactive read of the served assistant's id. */
export function getActiveAssistantId(): string {
  return useResolvedAssistantStoreBase.getState().assistant.assistantId;
}
