import { useEffect } from "react";

import { connectCloudAssistant } from "@/assistant/connect-assistant";
import { useAssistantResolution } from "@/assistant/queries";
import type { AssistantResolutionState } from "@/assistant/types";

import { publish } from "@/lib/event-bus";
import { setNotificationTapHandler } from "@/runtime/notifications";
import type { NotificationTapPayload } from "@/runtime/notification-taps";
import {
  useResolvedAssistantsStore,
  type ResolvedAssistant,
} from "@/stores/resolved-assistants-store";

const TAP_ACTIVATION_TIMEOUT_MS = 15_000;

/* Mirrored from useAssistantResolution so a terminal error releases wedged
 * activation waiters. */
let currentResolutionState: AssistantResolutionState = { kind: "loading" };
const activationWaiters = new Set<() => void>();
function wakeActivationWaiters() {
  for (const wake of activationWaiters) {
    wake();
  }
}

/**
 * The assistant a tap targets, if it is still in the roster. The roster is
 * the serving shell's own resolution projected into web — org-scoped by
 * construction and stamped before the first render — so a row's presence
 * already answers every "may this tap route" question the old session and
 * organization gates re-derived by hand: no session, no rows; a stale org's
 * assistant isn't in a current-org roster. What survives is the lookup.
 */
function resolveCurrentTapAssistant(
  payload: NotificationTapPayload,
): ResolvedAssistant | null {
  const identity = payload.identity;
  if (!identity) {
    return null;
  }
  return (
    useResolvedAssistantsStore
      .getState()
      .assistants.find((candidate) => candidate.id === identity.assistantId) ??
    null
  );
}

function waitForActiveTapAssistant(
  payload: NotificationTapPayload,
  assistantId: string,
): Promise<boolean> {
  const readOutcome = (): boolean | null => {
    if (!resolveCurrentTapAssistant(payload)) {
      return false;
    }
    const assistantsState = useResolvedAssistantsStore.getState();
    if (assistantsState.selectedAssistantId !== assistantId) {
      return false;
    }
    if (assistantsState.activeAssistantId === assistantId) {
      return true;
    }
    // A terminal resolution error means activation is wedged — release the
    // waiter instead of burning the timeout.
    const resolution = currentResolutionState;
    if (resolution.kind === "error" && !resolution.transient) {
      return false;
    }
    return null;
  };
  const immediate = readOutcome();
  if (immediate !== null) {
    return Promise.resolve(immediate);
  }
  return new Promise<boolean>((resolve) => {
    let unsubscribeAssistants = () => {};
    let cancellationTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (outcome: boolean) => {
      unsubscribeAssistants();
      activationWaiters.delete(settleIfComplete);
      if (cancellationTimer) {
        clearTimeout(cancellationTimer);
      }
      resolve(outcome);
    };
    const settleIfComplete = () => {
      const outcome = readOutcome();
      if (outcome === null) {
        return;
      }
      finish(outcome);
    };
    unsubscribeAssistants =
      useResolvedAssistantsStore.subscribe(settleIfComplete);
    cancellationTimer = setTimeout(() => {
      finish(false);
    }, TAP_ACTIVATION_TIMEOUT_MS);
    activationWaiters.add(settleIfComplete);
    settleIfComplete();
  });
}

/**
 * Routes notification taps to the originating conversation. Mounted at
 * `RootLayout` so a tap arriving on any route navigates.
 *
 * The tap's inputs are the payload and the assistant roster — nothing from
 * the session world. The serving shell resolved the assistant before web
 * loaded, so a tap has no session question to ask; a target that is gone
 * fails the roster lookup, and the connect path re-validates the platform
 * session itself, exactly as it does for every non-tap entry into the app.
 * The thread open publishes `deeplink.openThread` rather than navigating
 * directly so taps share the `cadet://thread/...` deep-link path — the same
 * channel, with the same server-side validity handling; no client-side
 * pre-validation a deep link never had.
 *
 * No effect cleanup: `setNotificationTapHandler` swaps the handler
 * reference in place and registers the cloud listeners only once
 * for the app's lifetime, so there is nothing to tear down.
 */
export function useNotificationTapNavigation(): void {
  const { state: resolutionState } = useAssistantResolution();
  useEffect(() => {
    currentResolutionState = resolutionState;
    wakeActivationWaiters();
  }, [resolutionState]);
  useEffect(() => {
    // Electron pop-out windows (`?popout=1`) mount `RootLayout` too, and
    // the macOS notification bridge broadcasts each action to every
    // BrowserWindow. Only the main window may handle taps — a pop-out
    // navigating would replace the conversation it exists to keep open.
    if (window.location.search.includes("popout=1")) {
      return;
    }
    setNotificationTapHandler(async (payload) => {
      if (!payload.conversationId) {
        return;
      }
      if (!payload.identity) {
        publish("deeplink.openThread", { threadId: payload.conversationId });
        return;
      }
      const assistant = resolveCurrentTapAssistant(payload);
      if (!assistant) {
        return;
      }
      const assistantSelection = useResolvedAssistantsStore.getState();
      if (
        assistantSelection.selectedAssistantId === assistant.id &&
        assistantSelection.activeAssistantId === assistant.id
      ) {
        publish("deeplink.openThread", { threadId: payload.conversationId });
        return;
      }
      try {
        // Connecting to lockfile entries is app-only: the app bundle owns
        // those connections, so a tap on one just opens the thread through
        // its owning host. Platform rows connect here.
        if (assistant.isCloudHosted) {
          await connectCloudAssistant(assistant.id);
        }
      } catch {
        return;
      }
      if (!(await waitForActiveTapAssistant(payload, assistant.id))) {
        return;
      }
      publish("deeplink.openThread", { threadId: payload.conversationId });
    });
  }, []);
}
