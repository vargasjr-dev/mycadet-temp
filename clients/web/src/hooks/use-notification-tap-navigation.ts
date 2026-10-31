import { useEffect } from "react";

import { publish } from "@/lib/event-bus";
import { setNotificationTapHandler } from "@/runtime/notifications";
import type { NotificationTapPayload } from "@/runtime/notification-taps";
import { getResolvedAssistant } from "@/stores/resolved-assistant-store";

/**
 * The assistant a tap targets, if it is the one this surface serves. The
 * served entry is the shell's own resolution stamped before the first
 * render, so its presence already answers every "may this tap route"
 * question the old session and organization gates re-derived by hand. A
 * tap for any other assistant has no answer here — which assistant a
 * surface serves is the host's fact, not a web selection.
 */
function resolveCurrentTapAssistant(
  payload: NotificationTapPayload,
): boolean {
  const identity = payload.identity;
  if (!identity) {
    return false;
  }
  const entry = getResolvedAssistant();
  return entry?.assistantId === identity.assistantId;
}

/**
 * Routes notification taps to the originating conversation. Mounted at
 * `RootLayout` so a tap arriving on any route navigates.
 *
 * The tap's inputs are the payload and the served assistant — nothing from
 * the session world. The serving shell resolved the assistant before web
 * loaded, so a tap has no session question to ask; a target that is not the
 * served assistant fails the lookup. The thread open publishes
 * `deeplink.openThread` rather than navigating directly so taps share the
 * `cadet://thread/...` deep-link path — the same channel, with the same
 * server-side validity handling; no client-side pre-validation a deep link
 * never had.
 *
 * No effect cleanup: `setNotificationTapHandler` swaps the handler
 * reference in place and registers the cloud listeners only once
 * for the app's lifetime, so there is nothing to tear down.
 */
export function useNotificationTapNavigation(): void {
  useEffect(() => {
    // Electron pop-out windows (`?popout=1`) mount `RootLayout` too, and
    // the macOS notification bridge broadcasts each action to every
    // BrowserWindow. Only the main window may handle taps — a pop-out
    // navigating would replace the conversation it exists to keep open.
    if (window.location.search.includes("popout=1")) {
      return;
    }
    setNotificationTapHandler((payload) => {
      if (!payload.conversationId) {
        return;
      }
      if (!payload.identity) {
        publish("deeplink.openThread", { threadId: payload.conversationId });
        return;
      }
      if (!resolveCurrentTapAssistant(payload)) {
        return;
      }
      publish("deeplink.openThread", { threadId: payload.conversationId });
    });
  }, []);
}
