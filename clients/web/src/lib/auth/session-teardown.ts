/**
 * Account-session teardown — the one path every sign-out in this bundle
 * rides. The teardown is ordering-sensitive: push-token unregistration runs
 * BEFORE the credential clear (the cloud delete authenticates with the
 * still-valid session cookie), and the account-scoped caches are dropped so
 * nothing signed-in outlives the session that produced it.
 */
import { setSelectedAssistant } from "@/assistant/selection";
import { logout as allauthLogout } from "@/lib/auth/allauth-client";
import { clearUserScopedStorage } from "@/lib/auth/session-cleanup";
import {
  getSelfHostedIngressUrl,
  setSelfHostedConnection,
} from "@/lib/self-hosted/connection";
import { isLocalClient } from "@/lib/local-mode";
import { resetNotificationIdentitySession } from "@/runtime/notification-avatar";
import { clearWidgetSnapshot } from "@/runtime/widget-snapshot";
import { deleteBiometricToken } from "@/runtime/native-biometric";
import { unregisterFromRemotePush } from "@/runtime/push-registration";
import { unregisterLiveActivityPushToken } from "@/domains/chat/voice/live-voice/live-activity-push-registration";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { isElectron } from "@/runtime/is-electron";
import { clearLocalCloudSession } from "@/runtime/local-mode-host";

let broadcastChannel: BroadcastChannel | null = null;

/**
 * Account-scoped cache hygiene for a session end. Notification identity
 * memory is invalidated synchronously so in-flight compositor work becomes
 * stale before any await. A Home Screen widget is readable without
 * unlocking the device, so the previous account's conversation titles must
 * not outlive the session that produced them, whichever way it ended. Its
 * clear is a no-op off Capacitor iOS.
 *
 * Awaited, but not gated on: a sign-out the bridge could refuse to complete
 * would be worse than a snapshot that outlives it by one launch. The clears
 * are idempotent, so a superseded observation running them after a session
 * end is harmless.
 */
export async function endSession(): Promise<void> {
  resetNotificationIdentitySession();
  await clearWidgetSnapshot();
}

/**
 * Tear the account session down. Two arms: a self-hosted ingress owns no
 * platform credential to revoke — its connection is the session — and the
 * platform arm revokes through allauth after the push tokens are dropped.
 */
export async function teardownSession(): Promise<void> {
  if (getSelfHostedIngressUrl() != null) {
    // The active-id clear must run BEFORE the selection clear in both
    // branches so subscribers never observe a stale assistant id in their
    // first re-render after the session ends.
    useResolvedAssistantsStore.getState().setActiveAssistantId(null);
    setSelfHostedConnection(null);
    await setSelectedAssistant(null);
    clearUserScopedStorage();
    await endSession();
    broadcastSessionEnd();
    return;
  }

  // Delete the APNs device token from the cloud BEFORE clearing the
  // session — the cloud delete is authenticated by the still-valid session
  // cookie. No-ops off native iOS. Best-effort: never blocks logout.
  await unregisterFromRemotePush();
  await unregisterLiveActivityPushToken();
  try {
    await allauthLogout();
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
    clearUserScopedStorage();
    useResolvedAssistantsStore.getState().setActiveAssistantId(null);
    await setSelectedAssistant(null);
    await endSession();
    broadcastSessionEnd();
  }
}

/**
 * Subscribe to cross-tab session-end messages: another tab's sign-out
 * clears this tab's user-scoped storage and reloads it into the signed-out
 * shell. Call once at app startup.
 */
export function watchCrossTabSessionEnd(): () => void {
  if (typeof BroadcastChannel === "undefined") {
    return () => {};
  }
  broadcastChannel = new BroadcastChannel("auth");
  broadcastChannel.onmessage = () => {
    clearUserScopedStorage();
    window.location.reload();
  };
  return () => {
    broadcastChannel?.close();
    broadcastChannel = null;
  };
}

function broadcastSessionEnd(): void {
  broadcastChannel?.postMessage("auth-changed");
}
