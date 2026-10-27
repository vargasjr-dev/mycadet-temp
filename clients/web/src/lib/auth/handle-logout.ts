import { stopWatch } from "@/domains/chat/watch/watch-controller";
import { hardNavigate } from "@/lib/auth/hard-navigate";
import { endSession } from "@/lib/auth/session-hygiene";
import {
  getActiveAssistant,
  isLocalAssistant,
  isLocalClient,
} from "@/lib/local-mode";
import { clearCompanionWorking } from "@/runtime/companion-surface";
import { setAssistantName } from "@/runtime/identity";
import { setMenuCloudSession } from "@/runtime/menu";
import { unregisterFromRemotePush } from "@/runtime/push-registration";
import { unregisterLiveActivityPushToken } from "@/domains/chat/voice/live-voice/live-activity-push-registration";
import { clearUserScopedStorage } from "@/lib/auth/session-cleanup";
import {
  getSelfHostedIngressUrl,
  setSelfHostedConnection,
} from "@/lib/self-hosted/connection";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { setSelectedAssistant } from "@/assistant/selection";
import { routes } from "@/utils/routes";

/**
 * Sign out from the assistant surface. The account teardown itself (credential
 * revocation, main-process sign-out) lives in the app bundle's logout page —
 * this bundle owns only what its renderer published or registered:
 *
 *   - the APNs / live-activity token deletes, which must reach the cloud
 *     while the session cookie is still valid, i.e. BEFORE the hand-off
 *   - the account-scoped caches (notification identity, Home Screen widget)
 *   - the selection and its user-scoped storage
 *   - the surface publishes (assistant name, companion surface, watch), given
 *     up in the last tick a renderer exists to publish from — the hard
 *     navigation below runs no unmount cleanup
 */
export async function handleLogout(): Promise<void> {
  if (isLocalClient()) {
    const active = getActiveAssistant();
    if (active && isLocalAssistant(active)) {
      // Signing out of the local assistant only: the cloud account stands,
      // so the session machinery is left untouched and the menu's
      // Log In/Log Out toggle is the only state that moves.
      await setMenuCloudSession(false);
      return;
    }
    if (getSelfHostedIngressUrl() != null) {
      // A self-hosted ingress is its own session: the connection slot IS the
      // credential, and no platform session is behind it to revoke. Drop the
      // slot and land on the local front door.
      useResolvedAssistantsStore.getState().setActiveAssistantId(null);
      setSelfHostedConnection(null);
      await setSelectedAssistant(null);
      clearUserScopedStorage();
      await endSession();
      hardNavigate(routes.welcome);
      return;
    }
    await setMenuCloudSession(false);
  }

  await unregisterFromRemotePush();
  await unregisterLiveActivityPushToken();
  // An in-flight turn's surface state must not outlive the sign-out: the
  // watch stop republishes the whole context with `working` recomputed from
  // the live stores, so it runs BEFORE the companion clear — the other order
  // would let the turn put the ring back after the clear.
  if (!isLocalClient()) {
    stopWatch();
  }
  // The published name tells main there is an assistant to draw, so a name
  // left standing keeps a floating pill on the desktop of someone who has
  // signed out of it. No-op off Electron.
  setAssistantName("");
  clearCompanionWorking();
  useResolvedAssistantsStore.getState().setActiveAssistantId(null);
  await setSelectedAssistant(null);
  setSelfHostedConnection(null);
  clearUserScopedStorage();
  await endSession();
  hardNavigate(routes.account.logout);
}
