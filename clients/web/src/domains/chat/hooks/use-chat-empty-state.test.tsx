/**
 * Tests for `useChatEmptyState`'s composition after the starter-chip and
 * suggestion-library removal.
 *
 * The hook now composes the greeting query and the app-editing override
 * only — the plain empty state carries no suggestion content, and the
 * app-editing side panel keeps its contextual chips.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import type { ConversationStarter } from "@/domains/chat/utils/conversation-starters";
import { DEFAULT_EMPTY_STATE_GREETING } from "@/domains/chat/utils/empty-state-constants";

import { useLiveVoiceStore } from "@/domains/chat/voice/live-voice/live-voice-store";
import { useChatEmptyState } from "@/domains/chat/hooks/use-chat-empty-state";
import type { UseChatEmptyStateParams } from "@/domains/chat/hooks/use-chat-empty-state";

function baseParams(
  overrides: Partial<UseChatEmptyStateParams> = {},
): UseChatEmptyStateParams {
  return {
    assistantId: "a1",
    conversationId: "c1",
    isEmptyConversation: true,
    avatar: { components: null, traits: null, customImageUrl: null } as never,
    mainView: "chat",
    openedAppState: null,
    isAssistantBusy: false,
    onSelectStarter: () => {},
    ...overrides,
  };
}

beforeEach(() => {
  useLiveVoiceStore.setState({ state: "idle" });
});

afterEach(() => {
  cleanup();
});

describe("useChatEmptyState", () => {
  test("the plain empty state carries no starters slot", () => {
    const { result } = renderHook(() => useChatEmptyState(baseParams()));
    expect(result.current.startersSlot).toBeUndefined();
  });

  test("the greeting rides through to the empty-state props", () => {
    const { result } = renderHook(() => useChatEmptyState(baseParams()));
    // No daemon in tests: the greeting query errors and the hook falls
    // back to the default headline.
    expect(result.current.emptyStateProps.greeting).toBe(
      DEFAULT_EMPTY_STATE_GREETING,
    );
  });

  test("the app-editing override derives its greeting and chips from the app", () => {
    const selected: ConversationStarter[] = [];
    const { result } = renderHook(() =>
      useChatEmptyState(
        baseParams({
          mainView: "app-editing",
          openedAppState: { name: "Todo List" },
          onSelectStarter: (s) => selected.push(s),
        }),
      ),
    );
    expect(result.current.emptyStateProps.greeting).toBe(
      "Editing Todo List. What should we change?",
    );
    expect(result.current.startersSlot).toBeDefined();
  });

  test("the avatar render function appears only when the avatar has content", () => {
    const empty = renderHook(() => useChatEmptyState(baseParams()));
    expect(empty.result.current.renderAvatar).toBeUndefined();
    empty.unmount();

    const withAvatar = renderHook(() =>
      useChatEmptyState(
        baseParams({
          avatar: {
            components: <div />,
            traits: null,
            customImageUrl: null,
          } as never,
        }),
      ),
    );
    expect(withAvatar.result.current.renderAvatar).toBeInstanceOf(Function);
    withAvatar.unmount();
  });

  test("the composer peek is mounted on the plain empty state only", () => {
    const plain = renderHook(() => useChatEmptyState(baseParams()));
    expect(plain.result.current.composerPeekSlot).toBeDefined();
    plain.unmount();

    const editing = renderHook(() =>
      useChatEmptyState(
        baseParams({ mainView: "app-editing", openedAppState: { name: "X" } }),
      ),
    );
    expect(editing.result.current.composerPeekSlot).toBeUndefined();
  });
});
