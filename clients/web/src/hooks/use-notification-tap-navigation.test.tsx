import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

import type { NotificationIdentity } from "@mycadet/ipc-contract";

import { resolveNotificationIdentityScope } from "@/runtime/notification-avatar";
import { __resetForTesting, subscribe } from "@/lib/event-bus";
import { createNotificationIdentity } from "@/runtime/notification-avatar";
import {
  __resetNotificationTapsForTests,
  type NotificationTapHandler,
  type NotificationTapPayload,
} from "@/runtime/notification-taps";
import { useResolvedAssistantStore } from "@/stores/resolved-assistant-store";

const ASSISTANT_A = "assistant-a";

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
  assistant: string = ASSISTANT_A,
): NotificationIdentity {
  // The resolver reads the served assistant, so borrow the store briefly to
  // derive a foreign identity and put this surface's assistant back.
  const previous = useResolvedAssistantStore.getState().assistantId;
  useResolvedAssistantStore.getState().setAssistantId(assistant);
  const scopeId = resolveNotificationIdentityScope();
  useResolvedAssistantStore.getState().setAssistantId(previous);
  const identity = scopeId
    ? createNotificationIdentity(scopeId, assistant)
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
  useResolvedAssistantStore.getState().setAssistantId(ASSISTANT_A);
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
    useResolvedAssistantStore.getState().setAssistantId(ASSISTANT_A);
    renderHook(() => useNotificationTapNavigation());
    const received = collectThreadOpens();

    await sendTap({
      conversationId: "conv-other",
      sourceEventName: "reminder.fired",
      identity: platformIdentity("assistant-other"),
    });

    expect(received).toEqual([]);
  });
});
