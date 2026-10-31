import type { LockfileAssistant } from "@/runtime/local-mode-host";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

import type { NotificationIdentity } from "@mycadet/ipc-contract";

import {
  resolveAssistantAvatarOwnerScopeId,
  resolveAssistantNotificationCloudId,
} from "@/hooks/use-assistant-avatar";
import { __resetForTesting, subscribe } from "@/lib/event-bus";
import { createNotificationIdentity } from "@/runtime/notification-avatar";
import {
  __resetNotificationTapsForTests,
  type NotificationTapHandler,
  type NotificationTapPayload,
} from "@/runtime/notification-taps";
import {
  useResolvedAssistantStore,
  
} from "@/stores/resolved-assistant-store";

const ASSISTANT_A: LockfileAssistant = {
  assistantId: "assistant-a",
  cloudAssistantId: "123e4567-e89b-12d3-a456-426614174000",
  cloud: "cloud",
  cloudOrganizationId: "org-1",
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

const { useNotificationTapNavigation } =
  await import("./use-notification-tap-navigation");

function platformIdentity(
  assistant: LockfileAssistant = ASSISTANT_A,
): NotificationIdentity {
  const scopeId = resolveAssistantAvatarOwnerScopeId(
    assistant,
    window.location.href,
  );
  const identity = scopeId
    ? createNotificationIdentity(
        scopeId,
        assistant.assistantId,
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
  window.history.pushState(null, "", "/");
  useResolvedAssistantStore.getState().setAssistant(ASSISTANT_A);
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
    expect(postLocalNotificationMock).not.toHaveBeenCalled();
  });

  test("a tap without a conversation publishes nothing", async () => {
    renderHook(() => useNotificationTapNavigation());
    const received = collectThreadOpens();

    await sendTap({ sourceEventName: "x" });

    expect(received).toEqual([]);
  });

  test("a tap for the served assistant opens its conversation", async () => {
    renderHook(() => useNotificationTapNavigation());
    const received = collectThreadOpens();

    await sendTap({
      conversationId: "conv-a",
      sourceEventName: "reminder.fired",
      identity: platformIdentity(ASSISTANT_A),
    });

    expect(received).toEqual([{ threadId: "conv-a" }]);
    expect(postLocalNotificationMock).not.toHaveBeenCalled();
  });

  test("a tap for another assistant has no answer in this surface", async () => {
    renderHook(() => useNotificationTapNavigation());
    const received = collectThreadOpens();

    await sendTap({
      conversationId: "conv-other",
      sourceEventName: "reminder.fired",
      identity: platformIdentity({
        assistantId: "assistant-other",
        cloud: "cloud",
        cloudAssistantId: "123e4567-e89b-12d3-a456-426614174001",
        cloudOrganizationId: "org-1",
      }),
    });

    expect(received).toEqual([]);
  });
});
