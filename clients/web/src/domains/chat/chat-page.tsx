/**
 * ChatPage — lifecycle guard layer for the chat route.
 *
 * Reads assistant lifecycle state and renders the appropriate screen:
 * - Auth / assistant loading → "Connecting…" placeholder
 * - Error, initializing, cleaning up, etc. → dedicated lifecycle screen
 * - Active (or self-hosted with flag) → mounts `ActiveChatView` for full orchestration
 *
 * By gating at the component boundary, orchestration hooks (SSE, TanStack Query,
 * Zustand subscriptions, keyboard listeners) only mount when the assistant is
 * actually usable — not during setup, cleanup, or error states.
 */

import { useCallback, useEffect, useRef } from "react";

import { assistantStateCanServeChat } from "@/assistant/lifecycle";
import { useAssistantResolution } from "@/assistant/queries";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useConversationListQuery } from "@/hooks/conversation-queries";
import { useIsSessionInitializing } from "@/stores/auth-store";
import { Button } from "@mycadet/design-library";

import { ActiveChatView } from "@/domains/chat/active-chat-view";
import { CleanupScreen } from "@/domains/chat/components/cleanup-screen";
import { SetupScreen } from "@/domains/chat/components/setup-screen";
import { useStuckConnecting } from "@/domains/chat/hooks/use-stuck-connecting";
import { useTranslation } from "@/i18n";

export function ChatPage() {
  const { t } = useTranslation("chat");
  const isSessionInitializing = useIsSessionInitializing();
  const { state: assistantState, refetch: refetchAssistantResolution } =
    useAssistantResolution();
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const shouldRenderChat = assistantStateCanServeChat(assistantState.kind);

  // Conversation list query — needed for the self-hosted error guard below.
  // TanStack Query deduplicates with the same query in ActiveChatView.
  const { isError: conversationListIsError, refetch: refetchConversationList } =
    useConversationListQuery(assistantId, shouldRenderChat);

  const retryAssistant = useCallback(() => {
    void refetchAssistantResolution();
  }, [refetchAssistantResolution]);

  // -------------------------------------------------------------------------
  // Loading guards — auth / assistant lifecycle not yet resolved
  // -------------------------------------------------------------------------
  const connectingReason = isSessionInitializing
    ? "auth_loading"
    : assistantState.kind === "loading"
      ? "assistant_loading"
      : null;

  // Watchdog: connecting has no natural failure surface, so a wedged auth
  // init or lifecycle probe would spin forever. Escalate to a retry screen
  // after a bounded wait (and report the episode).
  const { connectingStuck, resetStuckConnecting } =
    useStuckConnecting(connectingReason);
  const retryStuckConnecting = useCallback(() => {
    resetStuckConnecting();
    lifecycleService.retryAssistant();
  }, [resetStuckConnecting]);

  // Boot terminal outcome, or `null` while the page is still resolving. A
  // boot in flight is neither a success nor a failure until it settles: the
  // recovering states (initializing, cleaning_up, transient lifecycle errors)
  // must not be counted as terminal.
  // `connectingStuck` is only terminal while the page is STILL connecting.
  // `useStuckConnecting` clears its flag from an effect, so on the commit where
  // `connectingReason` flips to null the flag is briefly still true; reading it
  // unconditionally filed every recovered boot as a permanent failure, and the
  // retry button did the same.

  const lastConnectingReasonRef = useRef<string | null>(null);
  useEffect(() => {
    if (connectingReason === null) {
      lastConnectingReasonRef.current = null;
      return;
    }
    if (lastConnectingReasonRef.current === connectingReason) {
      return;
    }
    lastConnectingReasonRef.current = connectingReason;
  }, [connectingReason, assistantState.kind, assistantId]);

  if (connectingReason !== null) {
    if (connectingStuck) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
          <p className="text-[var(--content-secondary)]">
            {t("chatPage.connectingStuck")}
          </p>
          <Button variant="primary" onClick={retryStuckConnecting}>
            {t("chatPage.tryAgain")}
          </Button>
        </div>
      );
    }
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-[var(--content-secondary)]">
          {t("chatPage.connecting")}
        </p>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Lifecycle guards — non-active assistant states
  // -------------------------------------------------------------------------
  if (assistantState.kind === "error") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
        <p className="text-[var(--content-secondary)]">
          {assistantState.message}
        </p>
        <Button variant="primary" onClick={retryAssistant}>
          {assistantState.transient
            ? t("chatPage.retryNow")
            : t("chatPage.tryAgain")}
        </Button>
      </div>
    );
  }

  if (assistantState.kind === "initializing") {
    return <SetupScreen />;
  }

  if (assistantState.kind === "cleaning_up") {
    return <CleanupScreen />;
  }

  // Self-hosted runtime call failed — land on a terminal error state with a
  // retry button instead of leaving the sidebar + transcript stuck in the
  // seeded `isLoadingHistory` skeleton.
  if (assistantState.kind === "self_hosted" && conversationListIsError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
        <p className="text-[var(--content-secondary)]">
          {t("chatPage.selfHostedUnreachable")}
        </p>
        <Button variant="primary" onClick={refetchConversationList}>
          {t("chatPage.tryAgain")}
        </Button>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Active chat — all orchestration hooks mount inside ActiveChatView
  // -------------------------------------------------------------------------
  return (
    <>
      <span data-slot="active-chat-view" hidden />
      <ActiveChatView />
    </>
  );
}
