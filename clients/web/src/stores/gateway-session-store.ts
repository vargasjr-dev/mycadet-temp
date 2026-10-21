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

export interface GatewaySessionState {
  /** True once `ensureSession`/`refresh` has concluded for this lifetime. */
  settled: boolean;
  /** The one session question: is a session live? */
  live: boolean;
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

const useGatewaySessionStoreBase = create<GatewaySessionStore>()((set, get) => ({
  settled: false,
  live: false,
  identityKey: null,

  ensureSession: async () => {
    if (isDeviceSessionLive()) {
      set({ settled: true, live: true, identityKey: resolveIdentityKey() });
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
    set({ settled: true, live, identityKey: live ? resolveIdentityKey() : null });
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
    set({ settled: true, live: true, identityKey: resolveIdentityKey() });
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
    set({ settled: true, live: true, identityKey: resolveIdentityKey() });
  },

  /**
   * Connect to a cloud-hosted assistant. The platform gate is gone: the
   * host's user-session token authenticates, so connecting is selection
   * plus liveness.
   */
  connectCloudAssistant: async (assistantId: string) => {
    await setSelectedAssistant(assistantId);
    set({ settled: true, live: true, identityKey: resolveIdentityKey() });
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
    set({ settled: true, live: false, identityKey: null });
  },
}));

export const useGatewaySessionStore = createSelectors(useGatewaySessionStoreBase);

/** Reactive read of the one session question. */
export const useIsGatewaySessionLive = (): boolean =>
  useGatewaySessionStore.use.live();

/** Reactive read of the settled flag — gate behavior on this, not `live`. */
export const useIsGatewaySessionSettled = (): boolean =>
  useGatewaySessionStore.use.settled();

/** Reactive read of the assistant/guardian identity key. */
export const useGatewayIdentityKey = (): string | null =>
  useGatewaySessionStore.use.identityKey();
