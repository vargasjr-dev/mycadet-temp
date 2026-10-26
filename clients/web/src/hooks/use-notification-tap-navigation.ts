import { useEffect } from "react";

import {
  connectCloudAssistant,
  connectLocalAssistant,
  connectPairedAssistant,
} from "@/assistant/connect-assistant";
import { useAssistantResolution } from "@/assistant/queries";
import type { AssistantResolutionState } from "@/assistant/types";

import {
  resolveAssistantAvatarOwnerScopeId,
  resolveAssistantNotificationCloudId,
} from "@/hooks/use-assistant-avatar";
import { publish } from "@/lib/event-bus";
import { isLocalClient } from "@/lib/local-mode";
import { getSelfHostedIngressUrl } from "@/lib/self-hosted/connection";
import {
  createNotificationIdentity,
  sameNotificationIdentity,
} from "@/runtime/notification-avatar";
import { setNotificationTapHandler } from "@/runtime/notifications";
import type { NotificationTapPayload } from "@/runtime/notification-taps";
import {
  getCloudSession,
  getSessionStatus,
  subscribeSessionShape,
} from "@/lib/auth/session-shape";
import {
  getActiveOrganizationIdForRequests,
  useOrganizationStore,
} from "@/stores/organization-store";
import {
  useResolvedAssistantsStore,
  type ResolvedAssistant,
} from "@/stores/resolved-assistants-store";

const TAP_ACTIVATION_TIMEOUT_MS = 15_000;

/* Mirrored from useAssistantResolution so a terminal error settles wedged activation waiters. */
let currentResolutionState: AssistantResolutionState = { kind: "loading" };
const activationWaiters = new Set<() => void>();
function wakeActivationWaiters() {
  for (const wake of activationWaiters) {
    wake();
  }
}

function tapResolutionIsSettled(payload: NotificationTapPayload): boolean {
  const sessionStatus = getSessionStatus();
  if (sessionStatus === "unauthenticated") {
    return true;
  }
  const assistantsState = useResolvedAssistantsStore.getState();
  if (
    sessionStatus !== "authenticated" ||
    !assistantsState.assistantsHydrated
  ) {
    return false;
  }
  const assistant = assistantsState.assistants.find(
    (candidate) => candidate.id === payload.identity?.assistantId,
  );
  if (!assistant || !assistant.isCloudHosted) {
    return true;
  }
  // A cloud row's organization only hydrates under a live cloud session.
  // A platform commit always lands `cloudSession: "present"` alongside the
  // user, so an authenticated session without "present" here is a local
  // session (or a settled-absent cloud) — no org is coming either way, and
  // the connect path below re-validates the platform session itself.
  if (getCloudSession() !== "present") {
    return true;
  }
  const organization = useOrganizationStore.getState();
  return (
    getActiveOrganizationIdForRequests() !== null ||
    organization.status === "ready" ||
    organization.status === "error"
  );
}

function waitForTapResolutionReadiness(
  payload: NotificationTapPayload,
): Promise<void> {
  if (tapResolutionIsSettled(payload)) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let unsubscribeAuth = () => {};
    let unsubscribeOrganization = () => {};
    let unsubscribeAssistants = () => {};
    const settleIfReady = () => {
      if (!tapResolutionIsSettled(payload)) {
        return;
      }
      unsubscribeAuth();
      unsubscribeOrganization();
      unsubscribeAssistants();
      resolve();
    };
    unsubscribeAuth = subscribeSessionShape(settleIfReady);
    unsubscribeOrganization = useOrganizationStore.subscribe(settleIfReady);
    unsubscribeAssistants = useResolvedAssistantsStore.subscribe(settleIfReady);
    settleIfReady();
  });
}

function waitForActiveTapAssistant(
  payload: NotificationTapPayload,
  assistantId: string,
): Promise<boolean> {
  const readOutcome = (): boolean | null => {
    if (getSessionStatus() !== "authenticated") {
      return false;
    }
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
    let unsubscribeAuth = () => {};
    let unsubscribeOrganization = () => {};
    let unsubscribeAssistants = () => {};
    let cancellationTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (outcome: boolean) => {
      unsubscribeAuth();
      unsubscribeOrganization();
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
    unsubscribeAuth = subscribeSessionShape(settleIfComplete);
    unsubscribeOrganization = useOrganizationStore.subscribe(settleIfComplete);
    unsubscribeAssistants =
      useResolvedAssistantsStore.subscribe(settleIfComplete);
    cancellationTimer = setTimeout(() => {
      finish(false);
    }, TAP_ACTIVATION_TIMEOUT_MS);
    activationWaiters.add(settleIfComplete);
    settleIfComplete();
  });
}

function resolveCurrentTapAssistant(
  payload: NotificationTapPayload,
): ResolvedAssistant | null {
  const identity = payload.identity;
  if (!identity) {
    return null;
  }
  if (getSessionStatus() !== "authenticated") {
    return null;
  }
  const assistant = useResolvedAssistantsStore
    .getState()
    .assistants.find((candidate) => candidate.id === identity.assistantId);
  if (!assistant) {
    return null;
  }
  const scopeId = resolveAssistantAvatarOwnerScopeId(
    assistant,
    getActiveOrganizationIdForRequests(),
    getSelfHostedIngressUrl() ??
      (typeof globalThis.location === "undefined"
        ? null
        : globalThis.location.href),
  );
  const currentIdentity = scopeId
    ? createNotificationIdentity(
        scopeId,
        assistant.id,
        resolveAssistantNotificationCloudId(assistant),
      )
    : null;
  return currentIdentity && sameNotificationIdentity(identity, currentIdentity)
    ? assistant
    : null;
}

/**
 * Routes notification taps to the originating conversation. Mounted at
 * `RootLayout` so a tap arriving on any authenticated route navigates.
 *
 * Publishes `deeplink.openThread` rather than navigating directly so
 * taps share the `cadet://thread/...` deep-link path; one wiring
 * covers all three tap paths in `runtime/notifications.ts`.
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
      await waitForTapResolutionReadiness(payload);
      const assistant = resolveCurrentTapAssistant(payload);
      if (!assistant) {
        return;
      }
      const assistantSelection = useResolvedAssistantsStore.getState();
      if (
        assistantSelection.selectedAssistantId === assistant.id &&
        assistantSelection.activeAssistantId === assistant.id
      ) {
        if (!resolveCurrentTapAssistant(payload)) {
          return;
        }
        publish("deeplink.openThread", { threadId: payload.conversationId });
        return;
      }
      try {
        if (assistant.isPaired) {
          await connectPairedAssistant(assistant.id);
        } else if (assistant.isLocal && isLocalClient()) {
          await connectLocalAssistant(assistant.id);
        } else {
          await connectCloudAssistant(assistant.id);
        }
      } catch {
        return;
      }
      if (!(await waitForActiveTapAssistant(payload, assistant.id))) {
        return;
      }
      const activeSelection = useResolvedAssistantsStore.getState();
      if (
        activeSelection.selectedAssistantId !== assistant.id ||
        activeSelection.activeAssistantId !== assistant.id ||
        !resolveCurrentTapAssistant(payload)
      ) {
        return;
      }
      publish("deeplink.openThread", { threadId: payload.conversationId });
    });
  }, []);
}
