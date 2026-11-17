/**
 * The resolved assistant store — the one assistant this web surface serves.
 *
 * The web bundle exists only for a resolved assistant: the shell that mounts
 * it (the app bundle's iframe, the gateway-served host page) has already
 * resolved the assistant and stamps the id before the first render — locally
 * from the served synthesis, in the gateway-served world from the same
 * synthesis the host owns. There is no roster, no selection, and no
 * hydration question. The store is deliberately remote-agnostic: it carries
 * the assistant's identity (the id) and nothing about the serving topology —
 * the bundle's transport is same-origin regardless of which host serves it,
 * so no surface ever needed the topology fields a full assistant entry
 * would drag in.
 *
 * The id is non-nullable: there is no "unresolved" state to model, only the
 * empty id the cloud platform's own SPA observes before its projection
 * stamps — the platform serves this bundle for account/auth surfaces where
 * no assistant has been resolved yet, and the projection replaces the shell
 * wholesale in the same tick it lands. Assistant-scoped surfaces never see
 * the empty id: they mount only under a projected shell.
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";
import { readInjectedConfig } from "@/lib/injected-config";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

interface ResolvedAssistantState {
  /** The id of the one assistant this surface serves; empty pre-projection. */
  assistantId: string;
}

interface ResolvedAssistantActions {
  /**
   * Stamp (or replace) the served assistant's id. Replacing the shell
   * (`resetAssistant`) is the projection's job and the test reset's; a
   * production surface never clears the store.
   */
  setAssistantId: (assistantId: string) => void;
  /** Back to unresolved — the test reset. */
  resetAssistant: () => void;
}

const useResolvedAssistantStoreBase = create<
  ResolvedAssistantState & ResolvedAssistantActions
>()((set) => ({
  // The boot id: whatever the serving host stamped into the injected
  // config — read regardless of which host serves it, since the stamp is
  // the truth everywhere. A host fronting no assistant (the cloud SPA's
  // account surfaces) leaves the shell for the projection to replace.
  assistantId: readInjectedConfig()?.assistantId ?? "",
  setAssistantId: (assistantId) => set({ assistantId }),
  resetAssistant: () => set({ assistantId: "" }),
}));

export const useResolvedAssistantStore = createSelectors(
  useResolvedAssistantStoreBase,
);

/** Non-reactive read of the served assistant's id. */
export function getActiveAssistantId(): string {
  return useResolvedAssistantStoreBase.getState().assistantId;
}

function nonEmptyString(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** Name the shell injected at boot, when the config carries one. */
export function getAssistantName(): string | undefined {
  return nonEmptyString(readInjectedConfig()?.assistantName);
}

/** Live persona name when hydrated, else the name the shell injected. */
export function getAssistantDisplayName(): string | undefined {
  const live = useAssistantIdentityStore.getState().name?.trim();
  return live || getAssistantName();
}
