import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { __resetForTesting, publish } from "@/lib/event-bus";
import type { HistoryPaginationResult } from "@/domains/chat/transcript/use-history-pagination";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useComposerStore } from "@/domains/chat/composer-store";
import { useTurnStore } from "@/domains/chat/turn-store";
import { useConversationStore } from "@/stores/conversation-store";

// ---------------------------------------------------------------------------
// Module mock — `@/domains/chat/transcript/use-history-pagination`.
//
// Stub the TanStack Query layer so the test exercises only the reconnect →
// refetch wiring. `invalidate` is the spy under test; `isSuccess: false`
// keeps the data-apply effect (and its downstream interaction/surface
// fetches) dormant.
// ---------------------------------------------------------------------------
const realPaginationModule =
  await import("@/domains/chat/transcript/use-history-pagination");

let invalidateSpy = mock(async () => {});

function paginationStub(): HistoryPaginationResult {
  return {
    messages: [],
    latestPage: undefined,
    subagentNotifications: undefined,
    backgroundToolCompletions: undefined,
    isLoading: false,
    isSuccess: false,
    isError: false,
    error: null,
    hasMore: false,
    isFetchingOlderPages: false,
    isFetching: false,
    fetchOlderPage: () => {},
    invalidate: invalidateSpy,
    removeCache: () => {},
    latestPageOldestTimestamp: null,
    oldestLoadedTimestamp: null,
    dataUpdatedAt: 0,
  };
}

mock.module("@/domains/chat/transcript/use-history-pagination", () => ({
  ...realPaginationModule,
  useHistoryPagination: () => paginationStub(),
}));

// real gate reads auth/lifecycle/org stores that are out of scope here.

const { useConversationHistory } =
  await import("@/domains/chat/hooks/use-conversation-history");

// The hook reads `useQueryClient()` (for surface cache writes and the
// turn-end history reseed), so it must render inside a provider.
const queryClient = new QueryClient();

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function renderHistory(activeConversationId: string | null = "conv-A") {
  return renderHook(
    () =>
      useConversationHistory({
        assistantId: "asst-1",
        assistantStateKind: "active",
        activeConversationId,
      }),
    { wrapper: Wrapper },
  );
}

const invalidateQueriesSpy = spyOn(queryClient, "invalidateQueries");

beforeEach(() => {
  __resetForTesting();
  invalidateSpy = mock(async () => {});
  invalidateQueriesSpy.mockClear();
  useChatSessionStore.setState({
    snapshot: null,
    optimisticSends: [],
    previousConversationId: null,
    previousAssistantId: null,
    draftConversationIdResolution: false,
  });
  useComposerStore.getState().fullReset();
  useComposerStore.getState().setInput("");
});

afterEach(() => {
  cleanup();
  __resetForTesting();
  useChatSessionStore.setState({
    snapshot: null,
    optimisticSends: [],
    previousConversationId: null,
    previousAssistantId: null,
    draftConversationIdResolution: false,
  });
  useComposerStore.getState().fullReset();
  useComposerStore.getState().setInput("");
  useConversationStore.getState().removeProcessingConversationId("conv-A");
  useConversationStore.getState().removeProcessingConversationId("conv-B");
  useTurnStore.setState({ phase: "idle" });
});

describe("useConversationHistory — refetch on SSE reopen", () => {
  test("keeps composer state when the same history consumer becomes active again", () => {
    useChatSessionStore.setState({
      previousAssistantId: "asst-1",
      previousConversationId: "conv-A",
      draftConversationIdResolution: false,
    });
    useComposerStore.getState().setInput("Unsent draft");
    useComposerStore
      .getState()
      .addPathReferences(["/example/project-notes"]);

    const { rerender } = renderHook(
      ({ assistantStateKind }: { assistantStateKind: "loading" | "active" }) =>
        useConversationHistory({
          assistantId: "asst-1",
          assistantStateKind,
          activeConversationId: "conv-A",
        }),
      {
        wrapper: Wrapper,
        initialProps: {
          assistantStateKind: "loading" as "loading" | "active",
        },
      },
    );

    rerender({ assistantStateKind: "active" });

    expect(useComposerStore.getState().input).toBe("Unsent draft");
    expect(useComposerStore.getState().attachments).toMatchObject([
      {
        kind: "path-reference",
        path: "/example/project-notes",
      },
    ]);
    expect(useChatSessionStore.getState().previousAssistantId).toBe("asst-1");
    expect(useChatSessionStore.getState().previousConversationId).toBe(
      "conv-A",
    );
  });

  test("refetches history when the connection reopens after a resume", () => {
    /**
     * A resume reopen (return-from-background) past the daemon's 30s replay
     * ring must refetch `/messages` so an idle conversation's persisted tail
     * appears without a manual refresh.
     */
    // GIVEN an active conversation with a mounted history hook
    renderHistory("conv-A");

    // WHEN the bus reopens its SSE connection with a resume cause
    publish("sse.opened", { assistantId: "asst-1", cause: "resume" });

    // THEN the history query is invalidated to pull the latest snapshot
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
  });

  test.each([["error"], ["watchdog"], ["debug"]] as const)(
    "refetches history on a '%s' reconnect",
    (cause) => {
      /**
       * Every non-initial reopen is a catch-up opportunity: the connection
       * was previously established, so the snapshot may have advanced while
       * it was down.
       */
      // GIVEN an active conversation with a mounted history hook
      renderHistory("conv-A");

      // WHEN the bus reopens with a transport-recovery / debug cause
      publish("sse.opened", { assistantId: "asst-1", cause });

      // THEN the history query is invalidated
      expect(invalidateSpy).toHaveBeenCalledTimes(1);
    },
  );

  test("does not refetch on the first 'fresh' open", () => {
    /**
     * The initial connect's `refetchOnMount` already loaded the snapshot, so
     * a fresh open must not trigger a redundant second fetch.
     */
    // GIVEN an active conversation with a mounted history hook
    renderHistory("conv-A");

    // WHEN the bus reports the first fresh open
    publish("sse.opened", { assistantId: "asst-1", cause: "fresh" });

    // THEN no extra history refetch is issued
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  test("does not refetch on a cold-start 'anchor' reopen", () => {
    /**
     * The anchor bounce fires immediately after the fresh load with the ring
     * still warm, so the ring replay — not a refetch — is the catch-up.
     */
    // GIVEN an active conversation with a mounted history hook
    renderHistory("conv-A");

    // WHEN the bus reopens for the cold-start anchor replay
    publish("sse.opened", { assistantId: "asst-1", cause: "anchor" });

    // THEN no history refetch is issued
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  test("ignores reopens for a different assistant", () => {
    /**
     * The bus is assistant-global; a reopen for another assistant must not
     * refetch the active assistant's conversation.
     */
    // GIVEN an active conversation for asst-1
    renderHistory("conv-A");

    // WHEN a reopen arrives for a different assistant
    publish("sse.opened", { assistantId: "asst-other", cause: "resume" });

    // THEN the active assistant's history is not refetched
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  test("does not refetch when there is no active conversation", () => {
    /**
     * With no conversation selected there is nothing to reconcile, so a
     * reopen must be a no-op.
     */
    // GIVEN no active conversation
    renderHistory(null);

    // WHEN the bus reopens after a resume
    publish("sse.opened", { assistantId: "asst-1", cause: "resume" });

    // THEN no history refetch is issued
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  test("reseeds history from the server on a passively-observed processing→idle edge", () => {
    /**
     * Channel turns (phone, Slack, Telegram) and other-client sends stream in
     * without a local `useSendMessage`, so `turnPhase` never enters a sending
     * state. They still toggle the conversation's processing flag, so on the
     * processing→idle edge the materialized snapshot must be reseeded from the
     * authoritative server copy — pulled by invalidating the history query. The
     * monotonic seq baseline makes the reseed a no-op when nothing new landed.
     */
    // GIVEN an active conversation marked processing (a server-driven turn
    // streaming in)
    renderHistory("conv-A");
    act(() => {
      useConversationStore.getState().markConversationProcessing("conv-A");
    });
    // No reseed while the turn is still in progress.
    expect(invalidateSpy).not.toHaveBeenCalled();

    // WHEN the turn finishes and the processing flag clears
    act(() => {
      useConversationStore.getState().removeProcessingConversationId("conv-A");
    });

    // THEN the history query is invalidated so the snapshot reseeds.
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
  });

});
