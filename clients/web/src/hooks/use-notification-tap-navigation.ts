import { useEffect } from "react";

import { useAssistantLifecycleStore } from "@/assistant/lifecycle-store";
import type { AssistantState } from "@/assistant/types";
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
import { useGatewaySessionStore } from "@/stores/gateway-session-store";
import {
  getActiveOrganizationIdForRequests,
  useOrganizationStore,
} from "@/stores/organization-store";
import {
  useResolvedAssistantsStore,
  type ResolvedAssistant,
} from "@/stores/resolved-assistants-store";

const TAP_ACTIVATION_TIMEOUT_MS = 15_000;

function tapResolutionIsSettled(payload: NotificationTapPayload): boolean {
  const seam = useGatewaySessionStore.getState();
  if (seam.settled && !seam.live) {
    return true;
  }
  const assistantsState = useResolvedAssistantsStore.getState();
  if (!seam.live || !assistantsState.assistantsHydrated) {
    return false;
  }
  const assistant = assistantsState.assistants.find(
    (candidate) => candidate.id === payload.identity?.assistantId,
  );
  if (!assistant || !assistant.isCloudHosted) {
    return true;
  }
  if (!seam.identityKey) {
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
    unsubscribeAuth = useGatewaySessionStore.subscribe(settleIfReady);
    unsubscribeOrganization = useOrganizationStore.subscribe(settleIfReady);
    unsubscribeAssistants = useResolvedAssistantsStore.subscribe(settleIfReady);
    settleIfReady();
  });
}

function waitForActiveTapAssistant(
  payload: NotificationTapPayload,
  assistantId: string,
  lifecycleStateBeforeSwitch: AssistantState,
): Promise<boolean> {
  const readOutcome = (): boolean | null => {
    if (!useGatewaySessionStore.getState().live) {
      return false;
    }
    if (!resolveCurrentTapAssistant(payload)) {
      return false;
    }
    const assistantsState = useResolvedAssistantsStore.getState();
    if (assistantsState.selectedAssistantId !== assistantId) {
      return false;
    }
    const lifecycleState = useAssistantLifecycleStore.getState().assistantState;
    if (
      lifecycleState !== lifecycleStateBeforeSwitch &&
      lifecycleState.kind === "error" &&
      lifecycleState.transient !== true
    ) {
      return false;
    }
    return assistantsState.activeAssistantId === assistantId ? true : null;
  };
  const immediate = readOutcome();
  if (immediate !== null) {
    return Promise.resolve(immediate);
  }
  return new Promise<boolean>((resolve) => {
    let unsubscribeAuth = () => {};
    let unsubscribeLifecycle = () => {};
    let unsubscribeOrganization = () => {};
    let unsubscribeAssistants = () => {};
    let cancellationTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (outcome: boolean) => {
      unsubscribeAuth();
      unsubscribeLifecycle();
      unsubscribeOrganization();
      unsubscribeAssistants();
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
    unsubscribeAuth = useGatewaySessionStore.subscribe(settleIfComplete);
    unsubscribeLifecycle =
      useAssistantLifecycleStore.subscribe(settleIfComplete);
    unsubscribeOrganization = useOrganizationStore.subscribe(settleIfComplete);
    unsubscribeAssistants =
      useResolvedAssistantsStore.subscribe(settleIfComplete);
    cancellationTimer = setTimeout(() => {
      finish(false);
    }, TAP_ACTIVATION_TIMEOUT_MS);
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
  if (!useGatewaySessionStore.getState().live) {
    return null;
  }
  const assistant = useResolvedAssistantsStore
    .getState()
    .assistants.find((candidate) => candidate.id === identity.assistantId);
  if (!assistant) {
    return null;
  }
  const accountId = useGatewaySessionStore.getState().identityKey;
  const scopeId = resolveAssistantAvatarOwnerScopeId(
    assistant,
    accountId,
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
      const lifecycleStateBeforeSwitch =
        useAssistantLifecycleStore.getState().assistantState;
      try {
        const {
          connectPairedAssistant,
          connectLocalAssistant,
          connectCloudAssistant,
        } = useGatewaySessionStore.getState();
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
      if (
        !(await waitForActiveTapAssistant(
          payload,
          assistant.id,
          lifecycleStateBeforeSwitch,
        ))
      ) {
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
