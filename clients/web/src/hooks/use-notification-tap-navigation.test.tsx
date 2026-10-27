import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

import { useSyncExternalStore } from "react";
import type { AssistantResolutionState } from "@/assistant/types";

let resolutionState: AssistantResolutionState = { kind: "loading" };
const resolutionListeners = new Set<() => void>();
function setResolutionState(next: AssistantResolutionState) {
  resolutionState = next;
  for (const listener of resolutionListeners) {
    listener();
  }
}

mock.module("@/assistant/queries", () => ({
  useAssistantResolution: () => ({
    state: useSyncExternalStore(
      (cb) => {
        resolutionListeners.add(cb);
        return () => resolutionListeners.delete(cb);
      },
      () => resolutionState,
    ),
  }),
}));

import type { NotificationIdentity } from "@mycadet/ipc-contract";

import {
  resolveAssistantAvatarOwnerScopeId,
  resolveAssistantNotificationCloudId,
} from "@/hooks/use-assistant-avatar";
import { __resetForTesting, subscribe } from "@/lib/event-bus";
import { createNotificationIdentity } from "@/runtime/notification-avatar";
import {
  __resetNotificationTapsForTests,
  dispatchNotificationTap,
  registerNotificationTapHandler,
  type NotificationTapHandler,
  type NotificationTapPayload,
} from "@/runtime/notification-taps";
import { useAuthStore } from "@/stores/auth-store";
import {
  useResolvedAssistantsStore,
  type ResolvedAssistant,
} from "@/stores/resolved-assistants-store";

const ASSISTANT_A: ResolvedAssistant = {
  id: "assistant-a",
  cloudAssistantId: "123e4567-e89b-12d3-a456-426614174000",
  isLocal: false,
  isCloudHosted: true,
  isPaired: false,
  organizationId: "org-1",
};
const ASSISTANT_B: ResolvedAssistant = {
  id: "assistant-b",
  cloudAssistantId: "123e4567-e89b-12d3-a456-426614174001",
  isLocal: false,
  isCloudHosted: true,
  isPaired: false,
};

let capturedHandler: NotificationTapHandler | null = null;
const setNotificationTapHandlerMock = mock(
  (handler: NotificationTapHandler) => {
    capturedHandler = handler;
  },
);
const postLocalNotificationMock = mock(async () => {});
mock.module("@/runtime/notifications", () => ({
  setNotificationTapHandler: setNotificationTapHandlerMock,
  postLocalNotification: postLocalNotificationMock,
}));

const connectAssistantMock = () =>
  mock(async (assistantId: string) => {
    useResolvedAssistantsStore.setState({
      selectedAssistantId: assistantId,
      activeAssistantId: assistantId,
    });
  });

const connectCloudAssistantMock = connectAssistantMock();
const connectLocalAssistantMock = connectAssistantMock();
const connectPairedAssistantMock = connectAssistantMock();

mock.module("@/assistant/connect-assistant", () => ({
  connectCloudAssistant: connectCloudAssistantMock,
  connectLocalAssistant: connectLocalAssistantMock,
  connectPairedAssistant: connectPairedAssistantMock,
}));

function expectNoAssistantSwitch() {
  expect(connectCloudAssistantMock).not.toHaveBeenCalled();
  expect(connectLocalAssistantMock).not.toHaveBeenCalled();
  expect(connectPairedAssistantMock).not.toHaveBeenCalled();
}

const { useNotificationTapNavigation } =
  await import("./use-notification-tap-navigation");

function platformIdentity(
  assistant: ResolvedAssistant = ASSISTANT_A,
): NotificationIdentity {
  const scopeId = resolveAssistantAvatarOwnerScopeId(
    assistant,
    window.location.href,
  );
  const identity = scopeId
    ? createNotificationIdentity(
        scopeId,
        assistant.id,
        resolveAssistantNotificationCloudId(assistant),
      )
    : null;
  if (!identity) {
    throw new Error("expected notification identity");
  }
  return identity;
}

async function sendTap(payload: NotificationTapPayload): Promise<void> {
  const handler = capturedHandler;
  if (!handler) {
    throw new Error("expected notification tap handler");
  }
  await act(async () => {
    await handler(payload);
  });
}

function collectThreadOpens(): Array<{ threadId: string }> {
  const received: Array<{ threadId: string }> = [];
  subscribe("deeplink.openThread", (payload) => {
    received.push(payload);
  });
  return received;
}

beforeEach(() => {
  __resetForTesting();
  __resetNotificationTapsForTests();
  capturedHandler = null;
  setNotificationTapHandlerMock.mockClear();
  postLocalNotificationMock.mockClear();
  for (const connectMock of [
    connectCloudAssistantMock,
    connectLocalAssistantMock,
    connectPairedAssistantMock,
  ]) {
    connectMock.mockReset();
  }
  window.history.pushState(null, "", "/");
  useAuthStore.setState({
    sessionStatus: "authenticated",
    cloudSession: "present",
  });
  useResolvedAssistantsStore.setState({
    assistants: [ASSISTANT_A, ASSISTANT_B],
    assistantsHydrated: true,
    selectedAssistantId: ASSISTANT_B.id,
    activeAssistantId: ASSISTANT_B.id,
  });
  setResolutionState({ kind: "active", isLocal: false });
  for (const connectMock of [
    connectCloudAssistantMock,
    connectLocalAssistantMock,
    connectPairedAssistantMock,
  ]) {
    connectMock.mockImplementation(async (assistantId) => {
      useResolvedAssistantsStore.setState({
        selectedAssistantId: assistantId,
        activeAssistantId: assistantId,
      });
    });
  }
});

afterEach(() => {
  cleanup();
  __resetForTesting();
  __resetNotificationTapsForTests();
  window.history.pushState(null, "", "/");
});

describe("useNotificationTapNavigation", () => {
  test("mounting registers a tap handler", () => {
    renderHook(() => useNotificationTapNavigation());

    expect(setNotificationTapHandlerMock).toHaveBeenCalledTimes(1);
    expect(capturedHandler).not.toBeNull();
  });

  test("a popout registers no handler or navigation", () => {
    window.history.pushState(null, "", "/?popout=1");
    const received = collectThreadOpens();

    renderHook(() => useNotificationTapNavigation());

    expect(setNotificationTapHandlerMock).not.toHaveBeenCalled();
    expect(capturedHandler).toBeNull();
    expect(received).toEqual([]);
  });

  test("a legacy conversation-only tap remains compatible", async () => {
    renderHook(() => useNotificationTapNavigation());
    const received = collectThreadOpens();

    await sendTap({ conversationId: "conv-legacy", sourceEventName: "x" });

    expect(received).toEqual([{ threadId: "conv-legacy" }]);
    expectNoAssistantSwitch();
    expect(postLocalNotificationMock).not.toHaveBeenCalled();
  });

  test("a tap without a conversation publishes nothing", async () => {
    renderHook(() => useNotificationTapNavigation());
    const received = collectThreadOpens();

    await sendTap({ sourceEventName: "x" });

    expect(received).toEqual([]);
  });

  test("switches back to the scoped origin before opening its conversation", async () => {
    renderHook(() => useNotificationTapNavigation());
    const received = collectThreadOpens();

    await sendTap({
      conversationId: "conv-a",
      sourceEventName: "reminder.fired",
      identity: platformIdentity(ASSISTANT_A),
    });

    expect(connectCloudAssistantMock).toHaveBeenCalledWith(ASSISTANT_A.id);
    expect(received).toEqual([{ threadId: "conv-a" }]);
    expect(postLocalNotificationMock).not.toHaveBeenCalled();
  });

  test("opens an already active scoped target without reconnecting", async () => {
    useResolvedAssistantsStore.setState({
      selectedAssistantId: ASSISTANT_A.id,
      activeAssistantId: ASSISTANT_A.id,
    });
    connectCloudAssistantMock.mockRejectedValueOnce(
      new Error("offline reconnect should not run"),
    );
    renderHook(() => useNotificationTapNavigation());
    const received = collectThreadOpens();

    await sendTap({
      conversationId: "conv-active",
      sourceEventName: "reminder.fired",
      identity: platformIdentity(ASSISTANT_A),
    });

    expectNoAssistantSwitch();
    expect(received).toEqual([{ threadId: "conv-active" }]);
  });

  test("restores selection when the target is active but another is pending", async () => {
    useResolvedAssistantsStore.setState({
      selectedAssistantId: ASSISTANT_B.id,
      activeAssistantId: ASSISTANT_A.id,
    });
    renderHook(() => useNotificationTapNavigation());
    const received = collectThreadOpens();

    await sendTap({
      conversationId: "conv-restore",
      sourceEventName: "reminder.fired",
      identity: platformIdentity(ASSISTANT_A),
    });

    expect(connectCloudAssistantMock).toHaveBeenCalledWith(ASSISTANT_A.id);
    expect(received).toEqual([{ threadId: "conv-restore" }]);
  });

  test("waits for lifecycle activation after the selection write", async () => {
    connectCloudAssistantMock.mockImplementationOnce(async (assistantId) => {
      useResolvedAssistantsStore.setState({
        selectedAssistantId: assistantId,
      });
    });
    renderHook(() => useNotificationTapNavigation());
    const received = collectThreadOpens();
    const handler = capturedHandler;
    if (!handler) {
      throw new Error("expected notification tap handler");
    }

    const pendingTap = Promise.resolve(
      handler({
        conversationId: "conv-wait",
        sourceEventName: "reminder.fired",
        identity: platformIdentity(ASSISTANT_A),
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(connectCloudAssistantMock).toHaveBeenCalledWith(ASSISTANT_A.id);
    expect(received).toEqual([]);

    act(() => {
      useResolvedAssistantsStore.setState({
        activeAssistantId: ASSISTANT_A.id,
      });
    });
    await pendingTap;

    expect(received).toEqual([{ threadId: "conv-wait" }]);
  });

  test("a terminal lifecycle failure releases the next queued tap", async () => {
    connectCloudAssistantMock.mockImplementationOnce(async (assistantId) => {
      useResolvedAssistantsStore.setState({
        selectedAssistantId: assistantId,
      });
    });
    renderHook(() => useNotificationTapNavigation());
    const handler = capturedHandler;
    if (!handler) {
      throw new Error("expected notification tap handler");
    }
    registerNotificationTapHandler(handler);
    const received = collectThreadOpens();

    dispatchNotificationTap({
      conversationId: "conv-failed-activation",
      sourceEventName: "reminder.fired",
      identity: platformIdentity(ASSISTANT_A),
    });
    dispatchNotificationTap({
      conversationId: "conv-after-failure",
      sourceEventName: "legacy",
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(received).toEqual([]);

    act(() => {
      setResolutionState({ kind: "error", message: "activation failed" });
    });

    await waitFor(() => {
      expect(received).toEqual([{ threadId: "conv-after-failure" }]);
    });
    expect(received).not.toContainEqual({
      threadId: "conv-failed-activation",
    });
  });

  test("does not open a removed assistant target", async () => {
    const identity = platformIdentity(ASSISTANT_A);
    useResolvedAssistantsStore.setState({ assistants: [ASSISTANT_B] });
    renderHook(() => useNotificationTapNavigation());
    const received = collectThreadOpens();

    await sendTap({
      conversationId: "conv-removed",
      sourceEventName: "reminder.fired",
      identity,
    });

    expectNoAssistantSwitch();
    expect(received).toEqual([]);
  });

  test("drops the tap when switching the scoped assistant fails", async () => {
    connectCloudAssistantMock.mockRejectedValueOnce(
      new Error("connection failed"),
    );
    renderHook(() => useNotificationTapNavigation());
    const received = collectThreadOpens();

    await sendTap({
      conversationId: "conv-failed",
      sourceEventName: "reminder.fired",
      identity: platformIdentity(ASSISTANT_A),
    });

    expect(received).toEqual([]);
  });

  test("a non-auth resolution failure keeps an active target openable", async () => {
    // The session is fine — a mid-use assistant resolution hiccup must not
    // drop a tap whose target is already selected and active.
    setResolutionState({ kind: "error", message: "assistant hiccup" });
    useResolvedAssistantsStore.setState({
      selectedAssistantId: ASSISTANT_A.id,
      activeAssistantId: ASSISTANT_A.id,
    });
    renderHook(() => useNotificationTapNavigation());
    const received = collectThreadOpens();

    await sendTap({
      conversationId: "conv-hiccup",
      sourceEventName: "reminder.fired",
      identity: platformIdentity(ASSISTANT_A),
    });

    expectNoAssistantSwitch();
    expect(received).toEqual([{ threadId: "conv-hiccup" }]);
  });
});
