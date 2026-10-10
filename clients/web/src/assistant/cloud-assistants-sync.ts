/**
 * Platform assistants sync.
 *
 * Loads the cloud assistants list into the resolved-assistants store as a
 * reaction to the cloud session becoming present. `initSession`,
 * `refreshSession`, and app-resume revalidation all flip `cloudSession` to
 * `"present"` when they confirm a session, so one subscription repopulates the
 * list on every path.
 *
 * Cloud-remote only: the cloud web app's store is platform-driven, while the
 * single-assistant bundle served everywhere else configures its one assistant
 * at load and has no platform list to fetch.
 */
import { listAssistants } from "@/assistant/api";
import { subscribe } from "@/lib/event-bus";
import { isCadetCloudRemote } from "@/lib/local-mode";
import { captureError } from "@/lib/error-reporting/capture-error";
import { useAuthStore } from "@/stores/auth-store";
import { useOrganizationStore } from "@/stores/organization-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { hasLiveCloudSession } from "@/stores/session-status";

// Monotonic id stamped on each reload. The load is fire-and-forget and awaits
// two network hops, so a logout or account switch can land while it's in
// flight; only the newest reload for the still-present same-user session is
// allowed to write the resolved store, mirroring the auth store's own
// `latestPlatformProbe` guard.
let latestReload = 0;

// Stale-refresh bookkeeping, mirroring setupOrganizationStore: resume and
// chooser-mount refreshes only refetch when the last completed attempt is
// older than this, so rapid signals on fresh data stay cheap.
const STALE_TIME_MS = 10_000;
let lastLoadedAt = 0;

// The reload currently in flight, if any. Stale-gated refreshes coalesce onto
// it rather than starting a duplicate whose failure would supersede (and so
// discard) the first reload's successful write.
let inflightReload: Promise<void> | null = null;

/**
 * Load the cloud assistants list into the resolved-assistants store.
 *
 * No-ops outside cloud-remote: the bundle served everywhere else has no
 * platform list, so writing the resolved store there would clobber correct
 * state. On failure it marks the list hydrated so the route guard's hydration
 * wait can't stall navigation forever.
 *
 * Every write to the resolved store is gated on the reload still being current:
 * the same session (`cloudSession` still `"present"`, same `user.id`) and
 * not superseded by a newer reload. A stale reload writes nothing — a
 * signed-out session's route guard doesn't wait on `assistantsHydrated`, so
 * skipping the write there is correct.
 */
export function reloadCloudAssistants(): Promise<void> {
  if (!isCadetCloudRemote()) {
    return Promise.resolve();
  }
  const run = runReload();
  inflightReload = run;
  void run.finally(() => {
    if (inflightReload === run) {
      inflightReload = null;
    }
  });
  return run;
}

async function runReload(): Promise<void> {
  const gen = ++latestReload;
  const startUserId = useAuthStore.getState().user?.id ?? null;
  const isStale = (): boolean =>
    gen !== latestReload ||
    useAuthStore.getState().cloudSession !== "present" ||
    (useAuthStore.getState().user?.id ?? null) !== startUserId;

  try {
    await useOrganizationStore.getState().fetchOrganizations();
    const apiAssistants = await listAssistants();
    if (isStale()) {
      return;
    }
    if (apiAssistants.ok) {
      useResolvedAssistantsStore.getState().setFromApi(apiAssistants.data);
    } else {
      useResolvedAssistantsStore.getState().markHydrated();
    }
  } catch (err) {
    captureError(err, {
      context: "reloadCloudAssistants",
      bestEffort: true,
    });
    if (isStale()) {
      return;
    }
    useResolvedAssistantsStore.getState().markHydrated();
  } finally {
    lastLoadedAt = Date.now();
  }
}

/**
 * Reload the cloud assistants list unless the last attempt is fresh.
 *
 * Covers the post-hatch window where a self-hosted registration exists but its
 * `ingress_url` has not been provisioned yet: `setFromApi` drops the
 * unreachable entry and nothing else refetches, so the assistant would stay
 * absent until a reload or re-auth. Called on app resume and on chooser mount,
 * the moments a user would look for the new assistant. Session and mode guards
 * live here and in `reloadCloudAssistants`, so this is a no-op for
 * logged-out hubs and non-cloud modes. A reload already in flight is
 * awaited instead of duplicated; direct `reloadCloudAssistants` callers
 * (auth transitions, account switches) keep their latest-wins start.
 */
export async function refreshCloudAssistantsIfStale(): Promise<void> {
  if (!hasLiveCloudSession(useAuthStore.getState().cloudSession)) {
    return;
  }
  if (inflightReload) {
    await inflightReload;
    return;
  }
  if (Date.now() - lastLoadedAt <= STALE_TIME_MS) {
    return;
  }
  await reloadCloudAssistants();
}

/**
 * Subscribe to the auth store and reload the cloud assistants list whenever
 * the cloud session transitions to `"present"`. Register once at startup,
 * before `initSession`, so the boot `unknown → present` transition is caught.
 * Also refreshes on `app.resume` when the list is stale, since a self-hosted
 * assistant hatched elsewhere only becomes listable once its ingress
 * provisions. Returns an unsubscribe cleanup covering both subscriptions.
 */
export function setupCloudAssistantsSync(): () => void {
  const unsubAuth = useAuthStore.subscribe((state, prevState) => {
    if (
      prevState.cloudSession !== "present" &&
      state.cloudSession === "present"
    ) {
      void reloadCloudAssistants();
    }
  });
  const unsubResume = subscribe("app.resume", () => {
    void refreshCloudAssistantsIfStale();
  });
  return () => {
    unsubAuth();
    unsubResume();
  };
}
