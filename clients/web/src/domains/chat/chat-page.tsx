/**
 * ChatPage — the chat route.
 *
 * The web bundle exists only for a resolved assistant: the shell that
 * loads it (the app bundle's iframe, the gateway-served host page) has
 * already resolved the assistant, picked the selection, and settled auth.
 * There are no lifecycle screens here — orchestration hooks mount inside
 * `ActiveChatView`, and the only terminal screen is the self-hosted
 * runtime's own conversation-list failure.
 */

import { useActiveAssistantIsSelfHosted } from "@/assistant/hosting";
import { useConversationListQuery } from "@/hooks/conversation-queries";
import { Button } from "@mycadet/design-library";

import { ActiveChatView } from "@/domains/chat/active-chat-view";
import { useTranslation } from "@/i18n";
import { useResolvedAssistantId } from "@/assistant/use-active-assistant-id";

export function ChatPage() {
  const { t } = useTranslation("chat");
  const activeAssistantIsSelfHosted = useActiveAssistantIsSelfHosted();
  const assistantId = useResolvedAssistantId();

  // Conversation list query — needed for the self-hosted error guard below.
  // TanStack Query deduplicates with the same query in ActiveChatView.
  const { isError: conversationListIsError, refetch: refetchConversationList } =
    useConversationListQuery(assistantId);

  // Self-hosted runtime call failed — land on a terminal error state with a
  // retry button instead of leaving the sidebar + transcript stuck in the
  // seeded `isLoadingHistory` skeleton.
  if (activeAssistantIsSelfHosted && conversationListIsError) {
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
