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
import { useQuery } from "@tanstack/react-query";

import { assistantsRetrieve } from "@/generated/api/sdk.gen";
import { type Assistant, type GetAssistantResult } from "@/assistant/api";
import { assertHasResponse, toErrorObject } from "@/utils/api-errors";
import {
  getResolvedAssistant,
  useResolvedAssistantStore,
} from "@/stores/resolved-assistant-store";
import type { LockfileAssistant } from "@mycadet/local-mode/contract";

export const ASSISTANT_QUERY_KEY = ["assistant", "current"] as const;

/**
 * The store's entry in the generated-Assistant shape callers still speak.
 * The store IS the resolution — this is a projection of its one entry.
 */
export function asGeneratedAssistant(entry: LockfileAssistant): Assistant {
  return {
    id: entry.assistantId,
    handle: entry.assistantId,
    name: entry.name ?? entry.assistantId,
    status: "active",
    created: entry.hatchedAt ?? "",
  } as Assistant;
}

/**
 * The projection fetch: the platform's answer for the surface's one
 * assistant, addressed directly by the id the serving host stamped at boot.
 * The web bundle never lists assistants — it has no reason to: there is
 * exactly one assistant, and its id is known before the first render.
 */
async function fetchAssistantResolution(): Promise<GetAssistantResult> {
  const assistantId = getResolvedAssistant().assistantId;
  if (!assistantId) {
    return { ok: false, status: 404, error: { detail: "No assistants found" } };
  }
  const { data, error, response } = await assistantsRetrieve({
    path: { id: assistantId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to get assistant.");
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: toErrorObject(error, response),
    };
  }
  return { ok: true, status: response.status, data: data as Assistant };
}

/**
 * Project a fresh `/assistant/` answer onto the resolved-assistant store —
 * the API answer IS the new resolved assistant; that is the whole point of
 * the projection. Auth is handled app side, not web — the connection slots
 * are owned by the app's own session machinery.
 */
function projectAssistantResult(result: GetAssistantResult): void {
  if (!result.ok) {
    return;
  }
  useResolvedAssistantStore.getState().setAssistant({
    cloud: "cloud",
    assistantId: result.data.id,
    name: result.data.name,
    hatchedAt: result.data.created,
  });
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
    queryFn: fetchAssistantResolution,
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
