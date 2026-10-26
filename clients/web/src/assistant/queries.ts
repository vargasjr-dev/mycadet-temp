/**
 * TanStack Query layer for the assistant resolution resource.
 *
 * The web bundle is focused on one assistant whose auth is constant at
 * initial iframe load, so there is no runtime session lifecycle to manage —
 * no retry budgets, no watchdogs, no reachability polling. What remains is
 * the boot resolution: fetch `/assistant/` once (re-fetched on selection
 * change, retry, and while a transient phase is expected to resolve) and
 * project the result into the resolved-assistants store and the self-hosted
 * connection slots the request interceptor reads.
 *
 * `useAssistantBootResolution` mounts the resolution + its two projection
 * effects (the app root and standalone windows like the command palette);
 * `useAssistantResolution` is the read-only view every other consumer uses.
 *
 * @see {@link https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults}
 */

import { useEffect, useMemo } from "react";
import { useQuery, type QueryClient } from "@tanstack/react-query";

import { getAssistant, type GetAssistantResult } from "@/assistant/api";
import {
  resolveAssistantLifecycleState,
  TRANSPORT_ERROR_MESSAGE,
} from "@/assistant/lifecycle";
import type { AssistantResolutionState } from "@/assistant/types";
import {
  useGatedSelectedAssistantId,
  resolveSelectedAssistantId,
} from "@/assistant/selection";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import {
  getSelfHostedActorToken,
  setSelfHostedConnection,
} from "@/lib/self-hosted/connection";
import {
  getLocalAssistants,
  isServedGatewayRuntime,
  isLocalClient,
  getActiveAssistant,
  hasLocalGateway,
  expectsPairedGateway,
} from "@/lib/local-mode";
import { getActiveOrganizationIdForRequests } from "@/stores/organization-store";

export const ASSISTANT_QUERY_KEY = ["assistant", "current"] as const;

/**
 * Polling cadence while the assistant is in a transient lifecycle
 * phase. The daemon's startup is sub-second on healthy machines, so
 * 3 seconds gives margin on slow disks while keeping mobile data
 * costs reasonable.
 */
export const POLL_INTERVAL_MS = 3000;

/**
 * Lifecycle phases where we expect the assistant to transition soon
 * (typically within a few poll cycles). Other phases are stable; we
 * stop polling once we land in one of them so the tab isn't fetching
 * forever in the background.
 *
 * These are **lifecycle kinds** (the discriminator on
 * `AssistantResolutionState`), not raw server status strings.
 * Raw → kind mappings happen in `resolveAssistantLifecycleState`:
 *   - server `status: "initializing"`  → kind `initializing`
 *   - server `status: "to_be_deleted"` → kind `cleaning_up`
 *   - server `status: "active"`        → kind `active` / `self_hosted`
 *   - 404                              → kind `auto_hatch`
 *   - other non-OK                     → kind `error`
 */
const TRANSIENT_PHASES: ReadonlySet<
  Exclude<AssistantResolutionState, { kind: "loading" | "error" }>["kind"]
> = new Set(["initializing", "cleaning_up"]);

/**
 * The query's `refetchInterval` decision in a form callers can test
 * directly. Returns the cadence (ms) to poll at, or `false` to stop
 * polling. Lives at module scope so the unit tests can exercise the
 * same code path the runtime uses — duplicating the logic in a test
 * helper would let `TRANSIENT_PHASES` drift silently when a new
 * transient phase is added.
 */
export function pollIntervalFor(
  result: GetAssistantResult | undefined,
): number | false {
  if (!result) {
    return false;
  }
  const phase = resolveAssistantLifecycleState(result);
  return TRANSIENT_PHASES.has(phase.kind as "initializing")
    ? POLL_INTERVAL_MS
    : false;
}

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

/** The selection, unless it names a lockfile-only LOCAL assistant (gateway-based, never registered on the cloud — `getAssistant(id)` would 404). Managed AND platform self-hosted (API `is_local`) assistants ARE valid there — `projectAssistantResult` handles the self-hosted response — and a pre-hydration unknown id passes through for the 404 net. */
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
  return toCloudAssistantId(
    resolveSelectedAssistantId(getActiveOrganizationIdForRequests()),
  );
}

/**
 * Gateway-auth mode resolves the assistant locally — the gateway issues the
 * session token directly, so no `/assistant/` fetch happens. Primes the
 * self-hosted connection slots and publishes the active assistant id, and
 * answers whether this runtime IS a gateway-auth plane: the served-gateway
 * browser by construction, or a local client whose selected assistant
 * carries gateway machinery. On the platform plane it touches nothing —
 * the slots belong to the platform resolution — and answers false.
 */
export function applyGatewayAuthBoot(): boolean {
  let ingressUrl = window.location.origin;
  let resolvedAssistantId = "self";
  let rendererToken = getSelfHostedActorToken();
  if (isServedGatewayRuntime()) {
    ingressUrl = getRemoteGatewayIngressUrl();
  } else {
    const assistant = getActiveAssistant();
    // The unscoped gateway proxies died with the same-origin fold: a local
    // gateway entry or a paired entry both ride the scoped plane, and the
    // paired arm additionally holds no renderer token.
    if (
      assistant == null ||
      !(hasLocalGateway(assistant) || expectsPairedGateway(assistant))
    ) {
      return false;
    }
    resolvedAssistantId = assistant.assistantId;
    if (expectsPairedGateway(assistant)) {
      rendererToken = null;
    }
  }
  setSelfHostedConnection({ url: ingressUrl, token: rendererToken });
  useResolvedAssistantsStore
    .getState()
    .setActiveAssistantId(resolvedAssistantId);
  return true;
}

function getRemoteGatewayIngressUrl(): string {
  const match = /\/assistant(?:\/|$)/.exec(window.location.pathname);
  const prefix =
    match && match.index > 0
      ? window.location.pathname.slice(0, match.index).replace(/\/+$/, "")
      : "";
  return `${window.location.origin}${prefix}`;
}

/**
 * Project a resolution into the stores the rest of the bundle reads: the
 * resolved-assistants record + active id, and the self-hosted connection
 * slots the request interceptor consults.
 *
 * A cloud-active resolution drops any stale self-hosted connection (runtime
 * calls belong on the cloud); a self-hosted one records the user's gateway +
 * actor token so runtime-proxied calls rewrite to the gateway.
 */
function projectAssistantResult(result: GetAssistantResult): void {
  if (!result.ok) {
    return;
  }
  if (result.data.is_local) {
    setSelfHostedConnection({
      url: result.data.ingress_url,
      token: result.data.platform_actor_token,
    });
  } else {
    setSelfHostedConnection(null);
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
  if (applyGatewayAuthBoot()) {
    return queryClient.getQueryData(assistantQueryKey(null));
  }
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
  state: AssistantResolutionState;
  result: GetAssistantResult | undefined;
  selectedCloudAssistantId: string | null;
  refetch: ReturnType<typeof useQuery<GetAssistantResult>>["refetch"];
}

/**
 * The read-only view of the boot resolution. Shared cache — every consumer
 * sees the same answer without issuing its own fetch. The resolution runs
 * unconditionally: the web bundle is served for exactly one assistant, and
 * by the time it loads that assistant is resolved.
 */
export function useAssistantResolution(): AssistantResolutionResult {
  const selectedCloudAssistantId = useSelectedCloudAssistantId();

  const query = useQuery<GetAssistantResult>({
    queryKey: assistantQueryKey(selectedCloudAssistantId),
    queryFn: () => getAssistant(selectedCloudAssistantId ?? undefined),
    retry: false,
    refetchInterval: (q) => pollIntervalFor(q.state.data),
    refetchOnWindowFocus: false,
  });

  const state = useMemo<AssistantResolutionState>(() => {
    // Gateway-auth mode resolves the assistant locally — the gateway issues
    // the session token directly and there is nothing to fetch. The served
    // plane answers by construction; a local plane answers from the
    // lockfile roster the boot hydrated synchronously. The platform plane
    // derives from the fetch below.
    if (
      isServedGatewayRuntime() ||
      (isLocalClient() && getActiveAssistant() != null)
    ) {
      return { kind: "active", isLocal: true };
    }
    if (query.isPending) {
      return { kind: "loading" };
    }
    if (query.isError) {
      // A thrown fetch is a transport failure (the request never got an HTTP
      // answer) — the chat surface renders it with reconnecting copy.
      return {
        kind: "error",
        transient: true,
        message: TRANSPORT_ERROR_MESSAGE,
      };
    }
    return resolveAssistantLifecycleState(query.data);
  }, [query.isPending, query.isError, query.data]);

  return {
    state,
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

  // Gateway-auth mode: prime the connection slots + active id from local
  // state. Re-runs when the selection changes so a newly connected assistant
  // takes over. On the platform plane this touches nothing — the slots
  // belong to the platform resolution.
  useEffect(() => {
    applyGatewayAuthBoot();
  }, [selectedId]);

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
