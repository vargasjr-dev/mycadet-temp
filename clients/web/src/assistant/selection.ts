/**
 * The single read/write path for the selected assistant, shared by platform
 * and local flows so the two stop diverging.
 *
 * Read: `resolveSelectedAssistantId` validates the one selected id for the
 * active org, falling back to the lockfile `activeAssistant` and finally the
 * first valid assistant. `useGatedSelectedAssistantId` is the reactive
 * wrapper every React consumer goes through.
 *
 * Write: `setSelectedAssistant` records the selection AND mirrors it into the
 * lockfile `activeAssistant`, so the macOS tray, the CLI, and the native
 * client agree.
 */

import { getActiveAssistant, isServedGatewayRuntime } from "@/lib/local-mode";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

/**
 * Resolve the selected assistant id. There is one selection.
 *
 * Order:
 *   1. The selected id, if valid. An UNKNOWN id (no resolved entry)
 *      passes through only until the list is hydrated — pre-load the list may
 *      simply not have arrived yet. Once hydrated an unknown id is a ghost and
 *      falls through (the store also reconciles it away on lockfile load).
 *   2. Else the lockfile `activeAssistant`, if valid for the org.
 *   3. Else the first valid assistant for the org, or null.
 */
export function resolveSelectedAssistantId(): string | null {
  const { assistants, selectedAssistantId, assistantsHydrated } =
    useResolvedAssistantsStore.getState();
  const valid = assistants;
  const isValid = (id: string): boolean => valid.some((a) => a.id === id);

  if (selectedAssistantId !== null) {
    const known = assistants.some((a) => a.id === selectedAssistantId);
    if (isValid(selectedAssistantId)) {
      return selectedAssistantId;
    }
    // Unknown id: pass through only pre-hydration. Once the list is
    // authoritative, an id absent from it is a ghost — fall through.
    if (!known && !assistantsHydrated) {
      return selectedAssistantId;
    }
  }

  // Lockfile active, then first valid — both validated.
  const active = getActiveAssistant()?.assistantId ?? null;
  if (active !== null && isValid(active)) {
    return active;
  }

  return valid[0]?.id ?? null;
}

/**
 * Reactive read of the selection, shared by every consumer that must agree
 * with the lifecycle on which assistant is selected. The chooser runs on
 * local clients and the cloud hub alike, so the stored selection is
 * honored on every surface.
 * Gateway-auth mode and a missing org id return null: callers apply their own
 * fallback. The org id comes from the same derivation the
 * the resolved selection, or the persisted id standing in for it.
 * Subscribes to the selection, the resolved list, and its hydration marker
 * so consumers re-render when any resolution input changes (hydration alone
 * flips an unknown selected id from pass-through to ghost, even when the
 * list itself is unchanged).
 */
export function useGatedSelectedAssistantId(): string | null {
  useResolvedAssistantsStore.use.selectedAssistantId();
  useResolvedAssistantsStore.use.assistants();
  useResolvedAssistantsStore.use.assistantsHydrated();
  // On the served gateway there is nothing to select (one assistant, the
  // shell's). A local selection never survives the cloud-id filter
  // downstream (toCloudAssistantId), so no local-plane check is needed here.
  return !isServedGatewayRuntime() ? resolveSelectedAssistantId() : null;
}

/**
 * The single public write path for switching the selected assistant. Records
 * the selection (reactive slice + persisted key) and mirrors it into the
 * lockfile `activeAssistant` (a no-op in the browser, where there is no
 * lockfile host). The store action it wraps is internal plumbing — every
 * other caller goes through here.
 *
 * `null` clears the selection but skips the lockfile mirror: the host API has
 * no clear operation, and `activeAssistant` is machine-level tray/CLI state,
 * not session state.
 *
 * Selecting a lockfile-entry assistant is app-only: the app bundle owns
 * those connections and primes the gateway token before the write reaches
 * this wrapper.
 */
export async function setSelectedAssistant(id: string | null): Promise<void> {
  useResolvedAssistantsStore.getState().setSelectedAssistant(id);
}
