/**
 * TanStack Query layer for the assistant resolution resource.
 *
 * The web bundle exists only for a resolved assistant — the shell that
 * mounts it (the app bundle's iframe, the gateway-served host page) has
 * already resolved the assistant, picked the selection, and settled auth.
 * There is no resolution state machine here: no retry budgets, no
 * watchdogs, no polling, no failure renderings. What remains is the
 * projection fetch: `/assistant/` is fetched (re-fetched on selection
 * change or retry) and projected into the resolved-assistants store.
 *
 * `useAssistantBootResolution` mounts the fetch + its projection effect
 * (the app root and standalone windows like the command palette);
 * `useAssistantResolution` is the read-only view every other consumer uses.
 *
 * @see {@link https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults}
 */

import { useEffect } from "react";
import { useQuery, type QueryClient } from "@tanstack/react-query";

import { getAssistant, type GetAssistantResult } from "@/assistant/api";
import {
  useGatedSelectedAssistantId,
  resolveSelectedAssistantId,
} from "@/assistant/selection";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { getLocalAssistants } from "@/lib/local-mode";

export const ASSISTANT_QUERY_KEY = ["assistant", "current"] as const;

/**
 * Cache key for the `/assistant/` resolution.
 *
 * When no assistant is explicitly selected this is exactly
 * `ASSISTANT_QUERY_KEY` — so every existing `setQueryData` / `invalidate`
 * site keeps matching. When an id is selected the key is suffixed with it,
 * so switching assistants is a key change that triggers a fresh resolve.
 */
export function assistantQueryKey(
  selectedCloudAssistantId?: string | null,
): readonly unknown[] {
  return selectedCloudAssistantId
    ? [...ASSISTANT_QUERY_KEY, selectedCloudAssistantId]
    : ASSISTANT_QUERY_KEY;
}

/** The selection, unless it names a lockfile-only LOCAL assistant (gateway-based, never registered on the cloud — `getAssistant(id)` would 404). Managed AND platform assistants ARE valid there — `projectAssistantResult` projects the response — and a pre-hydration unknown id passes through for the 404 net. */
function toCloudAssistantId(resolvedSelectionId: string | null): string | null {
  return resolvedSelectionId &&
    !getLocalAssistants().some((a) => a.assistantId === resolvedSelectionId)
    ? resolvedSelectionId
    : null;
}

function useSelectedCloudAssistantId(): string | null {
  return toCloudAssistantId(useGatedSelectedAssistantId());
}

function resolveSelectedCloudAssistantId(): string | null {
  return toCloudAssistantId(resolveSelectedAssistantId());
}

/**
 * Fetch a fresh `/assistant/` resolution and project it onto the
 * resolved-assistants store. Auth is handled app side, not web — the
 * connection slots are owned by the app's own session machinery.
 */
function projectAssistantResult(result: GetAssistantResult): void {
  if (!result.ok) {
    return;
  }
  const store = useResolvedAssistantsStore.getState();
  store.upsertFromApi(result.data);
  store.setActiveAssistantId(result.data.id);
}

/**
 * Fetch a fresh `/assistant/` resolution and project it.
 *
 * `assistantIdOverride` pins this one refresh to a specific assistant
 * instead of the selection — the onboarding handoff uses it so a
 * just-hatched assistant is the one fetched and projected.
 */
export async function recheckAssistant(
  queryClient: QueryClient,
  assistantIdOverride?: string,
): Promise<GetAssistantResult | undefined> {
  const selectedId =
    assistantIdOverride ?? resolveSelectedCloudAssistantId() ?? null;
  const result = await queryClient.fetchQuery({
    queryKey: assistantQueryKey(selectedId),
    queryFn: () => getAssistant(selectedId ?? undefined),
    staleTime: 0,
  });
  // If the selected assistant 404s (retired/deleted), clear the stale
  // selection and retry without an ID so the resolution falls back to the
  // default first-listed assistant.
  if (selectedId && !result.ok && result.status === 404) {
    useResolvedAssistantsStore.getState().setSelectedAssistant(null);
    return recheckAssistant(queryClient);
  }
  projectAssistantResult(result);
  return result;
}

export interface AssistantResolutionResult {
  result: GetAssistantResult | undefined;
  selectedCloudAssistantId: string | null;
  refetch: ReturnType<typeof useQuery<GetAssistantResult>>["refetch"];
}

/**
 * The read-only view of the projection fetch. Shared cache — every consumer
 * sees the same answer without issuing its own fetch. The web bundle exists
 * only for a resolved assistant, so there is no state machine on top: the
 * result is data to project, not a lifecycle to render.
 */
export function useAssistantResolution(): AssistantResolutionResult {
  const selectedCloudAssistantId = useSelectedCloudAssistantId();

  const query = useQuery<GetAssistantResult>({
    queryKey: assistantQueryKey(selectedCloudAssistantId),
    queryFn: () => getAssistant(selectedCloudAssistantId ?? undefined),
    retry: false,
    refetchOnWindowFocus: false,
  });

  return {
    result: query.data,
    selectedCloudAssistantId,
    refetch: query.refetch,
  };
}

/**
 * The boot resolution: the shared read plus the projection effects. Mounted
 * once per running surface (the app root, and standalone windows like the
 * command palette that bypass it) — the effects are idempotent so an extra
 * mount is harmless.
 */
export function useAssistantBootResolution(): AssistantResolutionResult {
  const resolution = useAssistantResolution();
  const selectedId = resolution.selectedCloudAssistantId;

  useEffect(() => {
    const result = resolution.result;
    if (!result) {
      return;
    }
    // A selected id that 404s (retired/deleted) clears the stale selection —
    // the key change refetches the default assistant.
    if (!result.ok && result.status === 404 && selectedId) {
      useResolvedAssistantsStore.getState().setSelectedAssistant(null);
      return;
    }
    projectAssistantResult(result);
  }, [resolution.result, selectedId]);

  return resolution;
}
