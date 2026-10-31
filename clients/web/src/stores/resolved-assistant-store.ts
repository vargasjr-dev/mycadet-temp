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
 * same `LockfileAssistant` the rest of the stack speaks.
 *
 * @see lib/navigation/build-state.ts — derives `hasAssistants` from here
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";
import type { LockfileAssistant } from "@mycadet/local-mode/contract";

interface ResolvedAssistantState {
  /** The one assistant this web surface serves. */
  assistant: LockfileAssistant | null;
}

interface ResolvedAssistantActions {
  /**
   * Stamp (or replace) the served assistant. `null` clears it — test
   * reset and the degenerate pre-stamp state only; production surfaces
   * always stamp before rendering.
   */
  setAssistant: (entry: LockfileAssistant | null) => void;
}

const useResolvedAssistantStoreBase = create<
  ResolvedAssistantState & ResolvedAssistantActions
>()((set) => ({
  assistant: null,
  setAssistant: (entry) => set({ assistant: entry }),
}));

export const useResolvedAssistantStore = createSelectors(
  useResolvedAssistantStoreBase,
);

/** Non-reactive read of the served assistant. */
export function getResolvedAssistant(): LockfileAssistant | null {
  return useResolvedAssistantStoreBase.getState().assistant;
}

/** Non-reactive read of the served assistant's id. */
export function getActiveAssistantId(): string | null {
  return (
    useResolvedAssistantStoreBase.getState().assistant?.assistantId ?? null
  );
}

/** The id the cloud knows the assistant by: the lockfile's registration for a local instance, else the entry's own id. */
export function platformIdFor(entry: LockfileAssistant): string {
  return entry.cloudAssistantId ?? entry.assistantId;
}

/** {@link platformIdFor}; an id other than the served assistant's is its own platform id. */
export function resolveCloudAssistantId(assistantId: string): string {
  const entry = getResolvedAssistant();
  return entry && entry.assistantId === assistantId
    ? platformIdFor(entry)
    : assistantId;
}
