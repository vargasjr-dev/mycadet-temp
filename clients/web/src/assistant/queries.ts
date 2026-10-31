/**
 * TanStack Query layer for the assistant resolution resource.
 *
 * The web bundle exists only for a resolved assistant — the shell that
 * mounts it (the app bundle's iframe, the gateway-served host page) has
 * already resolved the assistant, picked the selection, and settled auth.
 * There is no resolution state machine here: no retry budgets, no
 * watchdogs, no polling, no failure renderings. What remains is the
 * projection fetch: `/assistant/` is fetched and projected onto the
 * resolved-assistant store — a refresh of the one assistant's identity,
 * not a roster load.
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
import { useResolvedAssistantStore } from "@/stores/resolved-assistant-store";
import { getLockfileAssistant } from "@/lib/local-mode";
import type { LockfileAssistant } from "@/runtime/local-mode-host";

export const ASSISTANT_QUERY_KEY = ["assistant", "current"] as const;

/**
 * Fetch a fresh `/assistant/` resolution and project it onto the
 * resolved-assistant store. Auth is handled app side, not web — the
 * connection slots are owned by the app's own session machinery.
 */
function projectAssistantResult(result: GetAssistantResult): void {
  if (!result.ok) {
    return;
  }
  const a = result.data;
  // The API answer refreshes the identity the entry already carries
  // (onboardedAt, registration, topology); an entry the lockfile has never
  // heard of exists only in the cloud-served world, so it normalizes to a
  // cloud entry.
  const entry = getLockfileAssistant(a.id);
  const merged: LockfileAssistant = entry
    ? { ...entry, name: a.name, hatchedAt: a.created }
    : {
        cloud: "cloud",
        assistantId: a.id,
        name: a.name,
        hatchedAt: a.created,
      };
  useResolvedAssistantStore.getState().setAssistant(merged);
}

/**
 * Fetch a fresh `/assistant/` resolution and project it.
 *
 * `assistantIdOverride` pins this one refresh to a specific assistant
 * instead of the served one — the onboarding handoff uses it so a
 * just-hatched assistant is the one fetched and projected.
 */
export async function recheckAssistant(
  queryClient: QueryClient,
  assistantIdOverride?: string,
): Promise<GetAssistantResult | undefined> {
  const result = await queryClient.fetchQuery({
    queryKey: ASSISTANT_QUERY_KEY,
    queryFn: () => getAssistant(assistantIdOverride),
    staleTime: 0,
  });
  projectAssistantResult(result);
  return result;
}

export interface AssistantResolutionResult {
  result: GetAssistantResult | undefined;
  refetch: ReturnType<typeof useQuery<GetAssistantResult>>["refetch"];
}

/**
 * The read-only view of the projection fetch. Shared cache — every consumer
 * sees the same answer without issuing its own fetch. The web bundle exists
 * only for a resolved assistant, so there is no state machine on top: the
 * result is data to project, not a lifecycle to render.
 */
export function useAssistantResolution(): AssistantResolutionResult {
  const query = useQuery<GetAssistantResult>({
    queryKey: ASSISTANT_QUERY_KEY,
    queryFn: () => getAssistant(),
    retry: false,
    refetchOnWindowFocus: false,
  });

  return {
    result: query.data,
    refetch: query.refetch,
  };
}

/**
 * The boot resolution: the shared read plus the projection effect. Mounted
 * once per running surface (the app root, and standalone windows like the
 * command palette that bypass it) — the effect is idempotent so an extra
 * mount is harmless.
 */
export function useAssistantBootResolution(): AssistantResolutionResult {
  const resolution = useAssistantResolution();

  useEffect(() => {
    if (resolution.result) {
      projectAssistantResult(resolution.result);
    }
  }, [resolution.result]);

  return resolution;
}
