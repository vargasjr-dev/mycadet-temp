/**
 * The gateway session seam — the one thing this bundle still knows about
 * identity: whether a session is live, and the assistant/guardian key that
 * scopes user-shaped storage (avatars, consent, the request cache).
 *
 * This replaces the auth store. The platform-session machinery it carried
 * (user snapshots, org hydration, cross-tab logout broadcast, cloud-session
 * offline restore, biometric/push/oauth-flow guards) died with it: sessions
 * are the host's business. Every request is authenticated by a *user*
 * session token (the cloud pattern) or a *device* gateway cookie (the
 * self-hosted pattern), attached by the consolidated routing — the bundle
 * only cares about the URL and whether a session is live, and once the
 * one-URL arc lands it won't be able to tell cloud-hosted from
 * self-hosted at all.
 *
 * The one deliberate holdover: a cloud remote still needs a boot-time
 * liveness probe, because its credential is a browser cookie that rides
 * requests invisibly — there is no token whose presence answers "live".
 * This is a raw credential check on the session endpoint (no client, no
 * user snapshot), and it retires with the one-URL arc's P1–P5, when the
 * origin's consolidated /v1 makes even this question the host's.
 */
import { create } from "zustand";

import type { LockfileAssistant } from "@mycadet/local-mode/contract";

import { lifecycleService } from "@/assistant/lifecycle-service";
import { setSelectedAssistant } from "@/assistant/selection";
import { createSelectors } from "@/utils/create-selectors";
import {
  getLockfileAssistant,
  getLocalAssistants,
  getSelectedAssistant,
  isLocalClient,
  isPairedAssistant,
  primeLocalGatewayConnection,
  primeLocalGatewayConnectionWithRepair,
} from "@/lib/local-mode";
import { bootstrapLocalAssistantCloudIdentity } from "@/lib/local-cloud-identity";
import {
  clearGatewayToken,
  getGatewayToken,
  isGatewayAuthEnabled,
  isGatewayAuthMode,
} from "@/lib/auth/gateway-session";
import { setSelfHostedConnection } from "@/lib/self-hosted/connection";
import { clearUserScopedStorage } from "@/lib/auth/session-cleanup";
// TEMPORARY projection imports — deleted with the auth store.
import { useAuthStore } from "@/stores/auth-store";
import {
  hasLiveCloudSession,
  isAuthenticated,
  isCloudSessionSettled,
  isSessionSettled,
} from "@/stores/session-status";
import { isCadetStaff } from "@/lib/auth/staff";

export interface GatewaySessionState {
  /** True once `ensureSession`/`refresh` has concluded for this lifetime. */
  settled: boolean;
  /** The one session question: is a session live? */
  live: boolean;
  /**
   * Whether a CLOUD (user-session) credential is live — the store's
   * `cloudSession: "present"` under the projection, the raw credential
   * probe's verdict once the seam drives itself. The resolver's
   * cloud-routing steps (checkout returns, billing) read this until the
   * billing slice retires them; the one-URL arc makes even this
   * distinction the host's.
   */
  cloudLive: boolean;
  /**
   * Whether the cloud credential's state has settled — `false` reproduces the
   * store's `cloudSession: "unknown"` so the resolver's onboarding fork and
   * the recovery latch keep their mid-probe semantics until the flip.
   */
  cloudSettled: boolean;
  /** Whether the session belongs to Cadet staff (the camera hud's gate). */
  isStaff: boolean;
  /**
   * The session's email — the feedback modal's pre-fill and anything else
   * that displayed the signed-in address. Post-flip the session
   * introspection carries it; device sessions have none.
   */
  email: string | null;
  /**
   * Stable identity key for storage namespacing and hashing — the selected
   * assistant's cloud id when it has one, else its local id. Replaces the
   * platform user id every former consumer hashed things against.
   */
  identityKey: string | null;
}

interface GatewaySessionActions {
  ensureSession: () => Promise<void>;
  refresh: () => Promise<boolean>;
  connectLocalAssistant: (assistantId: string) => Promise<void>;
  connectPairedAssistant: (assistantId: string) => Promise<void>;
  connectCloudAssistant: (assistantId: string) => Promise<void>;
  logout: () => Promise<void>;
}

export type GatewaySessionStore = GatewaySessionState & GatewaySessionActions;

/** The cloud's session-verification endpoint (credential check, no user body). */
const CLOUD_SESSION_PROBE_PATH = "/_allauth/browser/v1/session";

/**
 * Derive the identity key from the currently selected assistant. Falls back
 * to the local assistants list when the resolved selection hasn't hydrated.
 */
function resolveIdentityKey(): string | null {
  const selected: LockfileAssistant | undefined = getSelectedAssistant();
  const assistant = selected ?? getLocalAssistants()[0];
  if (!assistant) {
    return null;
  }
  const cloudId = (assistant as { cloudAssistantId?: string }).cloudAssistantId;
  return cloudId ?? assistant.assistantId ?? null;
}

/** Token/connection liveness that needs no network: the device patterns. */
function isDeviceSessionLive(): boolean {
  if (isGatewayAuthEnabled()) {
    return getGatewayToken() !== null;
  }
  return isLocalClient();
}

const useGatewaySessionStoreBase = create<GatewaySessionStore>()(
  (set, get) => ({
    settled: false,
    live: false,
    cloudLive: false,
    cloudSettled: false,
    isStaff: false,
    email: null,
    identityKey: null,

    ensureSession: async () => {
      if (isDeviceSessionLive()) {
        set({
          settled: true,
          live: true,
          cloudLive: false,
          identityKey: resolveIdentityKey(),
        });
        return;
      }
      // Cloud remote: the credential is a cookie — verify it with one raw
      // credential-check request. A settled rejection is simply "not live";
      // the recovery flow owns the redirect.
      let live = false;
      try {
        const response = await fetch(CLOUD_SESSION_PROBE_PATH, {
          method: "GET",
          credentials: "same-origin",
        });
        live = response.ok;
      } catch {
        live = false;
      }
      set({
        settled: true,
        live,
        cloudLive: live,
        cloudSettled: true,
        identityKey: live ? resolveIdentityKey() : null,
      });
    },

    refresh: async () => {
      if (!get().settled) {
        await get().ensureSession();
      } else if (isDeviceSessionLive()) {
        set({ live: true, identityKey: resolveIdentityKey() });
      } else {
        await get().ensureSession();
      }
      return get().live;
    },

    /**
     * Connect to a local assistant: primes the gateway connection (with
     * repair, since `wake` can start a local assistant), registers the
     * assistant's cloud identity, and marks the session live.
     */
    connectLocalAssistant: async (assistantId: string) => {
      const target = getLocalAssistants().find(
        (a) => a.assistantId === assistantId,
      );
      await primeLocalGatewayConnectionWithRepair(target);
      await setSelectedAssistant(assistantId);
      bootstrapLocalAssistantCloudIdentity(assistantId);
      set({
        settled: true,
        live: true,
        cloudLive: false,
        cloudSettled: true,
        identityKey: resolveIdentityKey(),
      });
    },

    /**
     * Connect to a paired assistant: a remote machine's assistant imported
     * via `cadet connect import`. Primes through the plain connection (a
     * remote `wake` can't start or repair anything) and skips the cloud
     * identity bootstrap — a paired entry is only a client-side record.
     */
    connectPairedAssistant: async (assistantId: string) => {
      const target = getLockfileAssistant(assistantId);
      if (!target || !isPairedAssistant(target)) {
        throw new Error("Not a paired assistant");
      }
      await primeLocalGatewayConnection(target);
      await setSelectedAssistant(assistantId);
      set({
        settled: true,
        live: true,
        cloudLive: false,
        cloudSettled: true,
        identityKey: resolveIdentityKey(),
      });
    },

    /**
     * Connect to a cloud-hosted assistant. The platform gate is gone: the
     * host's user-session token authenticates, so connecting is selection
     * plus liveness.
     */
    connectCloudAssistant: async (assistantId: string) => {
      await setSelectedAssistant(assistantId);
      set({
        settled: true,
        live: true,
        cloudLive: true,
        cloudSettled: true,
        identityKey: resolveIdentityKey(),
      });
    },

    /**
     * Drop the device credential and the user-shaped state this bundle owns.
     * Host-side session revocation is the caller's business (the app bundle /
     * handle-logout's hosted path).
     */
    logout: async () => {
      lifecycleService.resetForLogout();
      setSelfHostedConnection(null);
      await setSelectedAssistant(null);
      if (isGatewayAuthMode()) {
        clearGatewayToken();
      }
      clearUserScopedStorage();
      set({
        settled: true,
        live: false,
        cloudLive: false,
        cloudSettled: true,
        identityKey: null,
      });
    },
  }),
);

export const useGatewaySessionStore = createSelectors(
  useGatewaySessionStoreBase,
);

/** Reactive read of the one session question. */
export const useIsGatewaySessionLive = (): boolean =>
  useGatewaySessionStore.use.live();

/** Reactive read of the settled flag — gate behavior on this, not `live`. */
export const useIsGatewaySessionSettled = (): boolean =>
  useGatewaySessionStore.use.settled();

/** Reactive read of the assistant/guardian identity key. */
export const useGatewayIdentityKey = (): string | null =>
  useGatewaySessionStore.use.identityKey();

/**
 * Reactive: the session has not yet concluded for this lifetime — the
 * diagnostics-install gate in `AppProviders` (and anything else that must
 * not act on the pre-settle window) reads this rather than the old store
 * hook, which the projection keeps in lockstep anyway.
 */
export const useIsSessionInitializing = (): boolean =>
  !useIsGatewaySessionSettled();

/*
 * TEMPORARY projection — dies with the auth store.
 *
 * Until the last consumer leaves the auth store, its state machine stays the
 * session authority (boot still runs `initSession`; the probes, epochs, and
 * generation guards keep working exactly as built). This subscription mirrors
 * its settled state onto the seam, so consumers migrate onto the seam class
 * by class with every intermediate commit green. `identityKey` deliberately
 * does NOT mirror the platform user id — the collapse's whole point is that
 * storage and hashes key off the assistant/guardian, so even mid-transition
 * a consumer that reads `identityKey` is already on its final source. When
 * the last consumer leaves, the projection and the store are deleted
 * together and boot drives the seam directly.
 */
export function projectAuthStoreOntoSeam(): () => void {
  const project = (state: {
    sessionStatus: Parameters<typeof isSessionSettled>[0];
    cloudSession: Parameters<typeof hasLiveCloudSession>[0];
    user: Parameters<typeof isCadetStaff>[0];
  }) => {
    useGatewaySessionStoreBase.setState({
      settled: isSessionSettled(state.sessionStatus),
      live: isAuthenticated(state.sessionStatus),
      cloudLive: hasLiveCloudSession(state.cloudSession),
      cloudSettled: isCloudSessionSettled(state.cloudSession),
      isStaff: isCadetStaff(state.user),
      email: state.user?.email ?? null,
      identityKey: resolveIdentityKey(),
    });
  };
  const unsubscribe = useAuthStore.subscribe(project);
  // Seed from current state so the seam is truthful before the first write.
  project(useAuthStore.getState());
  return unsubscribe;
}
