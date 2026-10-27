/**
 * Zustand auth store.
 *
 * Gateway machinery only: boot primes the selected assistant's gateway
 * connection (riding out its startup window), app-resume re-verifies it, and
 * logout tears the session down. The platform account session is owned by the
 * app bundle's account source, not here.
 *
 * References:
 * - https://zustand.docs.pmnd.rs/guides/reading-and-writing-state-outside-components
 * - https://docs.allauth.org/en/latest/headless/openapi-specification/
 */
import { create } from "zustand";

import { setSelectedAssistant } from "@/assistant/selection";

import { logout as allauthLogout } from "@/lib/auth/allauth-client";
import { clearWidgetSnapshot } from "@/runtime/widget-snapshot";
import { resetNotificationIdentitySession } from "@/runtime/notification-avatar";
import {
  isLocalClient,
  hasLocalGateway,
  hasPairedGateway,
  getActiveAssistant,
  primeLocalGatewayConnection,
  primeLocalGatewayConnectionWithStartupRetry,
} from "@/lib/local-mode";
import { getSelfHostedIngressUrl } from "@/lib/self-hosted/connection";

import { deleteBiometricToken } from "@/runtime/native-biometric";
import { unregisterLiveActivityPushToken } from "@/domains/chat/voice/live-voice/live-activity-push-registration";
import { unregisterFromRemotePush } from "@/runtime/push-registration";
import { clearUserScopedStorage } from "@/lib/auth/session-cleanup";
import { setSelfHostedConnection } from "@/lib/self-hosted/connection";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { subscribe } from "@/lib/event-bus";
import { isElectron } from "@/runtime/is-electron";
import { clearLocalCloudSession } from "@/runtime/local-mode-host";

interface AuthActions {
  initSession: () => Promise<void>;
  refreshSession: () => Promise<void>;
  /** App can supply cloud revocation while retaining shared native/assistant cleanup. */
  logout: (options?: {
    cloudAccount?: { revokeSession(): Promise<void> };
  }) => Promise<void>;
}

let broadcastChannel: BroadcastChannel | null = null;

/**
 * Whether the app booted on the public `/assistant/pair` route (prefix-
 * tolerant: tunnel-served deployments live under `/assistant-123/…`).
 */
function onPublicPairingRoute(): boolean {
  return /\/assistant\/pair\/?$/.test(window.location.pathname);
}

/** Session-end teardown. Every path that ends a session goes through here. */
async function endSession(): Promise<void> {
  resetNotificationIdentitySession();
  await clearWidgetSnapshot();
}

export const useAuthStore = create<AuthActions>()(() => ({
  initSession: async () => {
    // The public pair page establishes its session through the pairing flow
    // itself; any retained session state is stale.
    if (onPublicPairingRoute()) {
      await endSession();
      return;
    }
    // Ride out the gateway's startup window: on reboot the gateway (a
    // Login Item) restarts concurrently with the app, so a single prime
    // would surface recovery controls for an assistant that reconnects on
    // its own. Still no `wake`: app launch must not spawn assistant
    // processes.
    if (
      hasLocalGateway(getActiveAssistant()) ||
      hasPairedGateway(getActiveAssistant())
    ) {
      try {
        await primeLocalGatewayConnectionWithStartupRetry();
      } catch {
        await endSession();
      }
    }
  },

  refreshSession: async () => {
    // Machinery re-verification, not a session question — the web bundle
    // holds no gateway session. A selection with a resolvable gateway gets
    // its connection re-primed (the prime rebuilds a dead slot); everything
    // else is owned by the app bundle's account source.
    const selectedAssistant = getActiveAssistant();
    if (
      selectedAssistant &&
      (hasPairedGateway(selectedAssistant) ||
        hasLocalGateway(selectedAssistant))
    ) {
      try {
        await primeLocalGatewayConnection();
      } catch {
        await endSession();
      }
    }
  },

  logout: async (options) => {
    if (getSelfHostedIngressUrl() != null && !options?.cloudAccount) {
      useResolvedAssistantsStore.getState().setActiveAssistantId(null);
      setSelfHostedConnection(null);
      await setSelectedAssistant(null);
      clearUserScopedStorage();
      await endSession();
      broadcastAuthChange();
      return;
    }

    // Delete the APNs device token from the cloud BEFORE clearing the
    // session — the cloud delete is authenticated by the still-valid
    // session cookie. No-ops off native iOS. Best-effort: never blocks logout.
    await unregisterFromRemotePush();
    await unregisterLiveActivityPushToken();
    try {
      if (options?.cloudAccount) {
        await options.cloudAccount.revokeSession();
      } else {
        await allauthLogout();
      }
    } finally {
      // Clean up session token in the main process.
      if (isElectron()) {
        await window.cadet?.auth?.signOut?.();
      }
      // Web loopback: drop the token the local server's proxy authenticates with.
      if (isLocalClient() && !isElectron()) {
        await clearLocalCloudSession();
      }
      void deleteBiometricToken();
      if (options?.cloudAccount && getSelfHostedIngressUrl() != null) {
        setSelfHostedConnection(null);
      }
      clearUserScopedStorage();
      useResolvedAssistantsStore.getState().setActiveAssistantId(null);
      await setSelectedAssistant(null);
      await endSession();
      broadcastAuthChange();
    }
  },
}));

/**
 * Subscribe to app-resume signals on the layout-scoped event bus and to
 * cross-tab BroadcastChannel messages. Call once at app startup.
 */
export function setupAuthListeners(): () => void {
  const { refreshSession } = useAuthStore.getState();
  const cleanups: Array<() => void> = [];

  const unsubResume = subscribe("app.resume", () => {
    void refreshSession().catch((err: unknown) =>
      console.warn("auth.refreshSession failed", err),
    );
  });
  cleanups.push(unsubResume);

  if (typeof BroadcastChannel !== "undefined") {
    broadcastChannel = new BroadcastChannel("auth");
    broadcastChannel.onmessage = () => {
      clearUserScopedStorage();
      window.location.reload();
    };
    cleanups.push(() => {
      broadcastChannel?.close();
      broadcastChannel = null;
    });
  }

  return () => cleanups.forEach((fn) => fn());
}

function broadcastAuthChange(): void {
  broadcastChannel?.postMessage("auth-changed");
}
