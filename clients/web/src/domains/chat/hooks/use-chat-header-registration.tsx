/**
 * Writes chat-specific header data to the layout slots store so
 * ChatConversationHeader (rendered by ChatLayout) can build the
 * complete actions menu without duplicating hooks or state.
 *
 * Owns:
 * - `headerSupplements` computation and slot registration
 * - `topBarRightSlot` (ChannelSourceLinkPill, plus the
 *   ConversationAssetsPill Chat Info trigger) computation and registration
 * - Slack conversation display derivation for the header label and the
 *   source-thread link
 */

import { useEffect, useMemo } from "react";

import { useChatLayoutSlotsStore } from "@/components/layout/chat-layout-slots-store";
import type { ChatHeaderSupplements } from "@/components/layout/chat-layout-slots-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useConversationStore } from "@/stores/conversation-store";
import { useTranscriptMessages } from "@/domains/chat/transcript/use-transcript-messages";
import { useActiveConversation } from "@/domains/chat/hooks/use-active-conversation";
import { useSlackConversationDisplay } from "@/domains/chat/hooks/use-slack-conversation-display";
import { formatSlackConversationDisplayLabel } from "@/domains/chat/utils/slack-conversation-display";
import { getExternalLinkUrl } from "@/domains/chat/types/types";
import { isChannelConversation } from "@/domains/chat/utils/conversation-channel";
import { getChannelBindingDisplayText } from "@/domains/chat/utils/channel-conversation-display";
import { getChannelLabel } from "@/utils/channel-presentation";
import { ChannelSourceLinkPill } from "@/domains/chat/components/channel-source-link-pill";
import { ConversationAssetsPill } from "@/domains/chat/components/conversation-assets-pill";

import type { Conversation } from "@/types/conversation-types";

export interface UseChatHeaderRegistrationOptions {
  assetsRefreshKey: number;
  /** Forks through the latest persisted message. Omitted unless the viewer
   *  passes the staff gate, which drops the menu item. */
  handleForkConversationFromMenu?: () => void;
  handleOpenInNewWindow: (conversation: Conversation) => void;
  handleInspectConversation: (conversation: Conversation) => void;
  handleCopyConversation: () => void;
  onRefresh: () => void;
}

export function useChatHeaderRegistration({
  assetsRefreshKey,
  handleForkConversationFromMenu,
  handleOpenInNewWindow,
  handleInspectConversation,
  handleCopyConversation,
  onRefresh,
}: UseChatHeaderRegistrationOptions): void {
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const activeConversationId = useConversationStore.use.activeConversationId();
  const messages = useTranscriptMessages();
  const setTopBarRightSlot = useChatLayoutSlotsStore.use.setTopBarRightSlot();
  const setHeaderSupplements =
    useChatLayoutSlotsStore.use.setHeaderSupplements();

  const activeConversation = useActiveConversation(
    assistantId,
    activeConversationId,
    true,
  );

  // Channel header tag derivation. Slack keeps its richer label (channel
  // vs DM, lazy name resolution); other channels fall back to the generic
  // binding name, then the channel's human label.
  const slackConversationDisplay = useSlackConversationDisplay({
    assistantId: assistantId ?? undefined,
    conversation: activeConversation,
    messages,
  });
  const channelHeaderChannelId = isChannelConversation(activeConversation)
    ? (activeConversation?.originChannel ?? null)
    : null;
  const channelHeaderLabel = useMemo(() => {
    if (!channelHeaderChannelId) {
      return null;
    }
    if (channelHeaderChannelId === "slack") {
      return slackConversationDisplay
        ? formatSlackConversationDisplayLabel(slackConversationDisplay)
        : getChannelLabel("slack");
    }
    return (
      getChannelBindingDisplayText(activeConversation?.channelBinding) ??
      getChannelLabel(channelHeaderChannelId)
    );
  }, [
    channelHeaderChannelId,
    slackConversationDisplay,
    activeConversation?.channelBinding,
  ]);

  // Deep link back to the conversation's source in the external channel.
  // Slack's display href comes first because it is richer — it folds in
  // message-level links from the transcript — and it also covers daemons
  // that predate the binding's channel-neutral `sourceLink`. Every other
  // channel goes through `sourceLink`, so a channel lights up here as soon
  // as its daemon-side binding-metadata builder emits one.
  const channelSourceLinkHref = channelHeaderChannelId
    ? (slackConversationDisplay?.href ??
      getExternalLinkUrl(activeConversation?.channelBinding?.sourceLink) ??
      null)
    : null;

  // Header supplements — chat-specific data for the conversation header menu
  const hasPersistedMessage = useMemo(
    () => messages.some((m) => m.id != null),
    [messages],
  );

  const headerSupplements = useMemo<ChatHeaderSupplements>(
    () => ({
      hasPersistedMessage,
      channelHeaderLabel,
      channelHeaderChannelId,
      channelSourceLinkHref,
      onForkConversation: handleForkConversationFromMenu ?? null,
      onOpenInNewWindow: handleOpenInNewWindow,
      onInspect: handleInspectConversation,
      onCopyConversation: messages.length > 0 ? handleCopyConversation : null,
      onRefresh,
    }),
    [
      hasPersistedMessage,
      channelHeaderLabel,
      channelHeaderChannelId,
      channelSourceLinkHref,
      handleForkConversationFromMenu,
      handleOpenInNewWindow,
      handleInspectConversation,
      handleCopyConversation,
      messages.length,
      onRefresh,
    ],
  );

  useEffect(() => {
    setHeaderSupplements(headerSupplements);
    return () => {
      setHeaderSupplements(null);
    };
  }, [headerSupplements, setHeaderSupplements]);

  // Top bar right slot - ConversationAssetsPill
  const topBarRightContent = useMemo(() => {
    if (!activeConversation?.conversationId || !assistantId) {
      return null;
    }
    return (
      <>
        {channelSourceLinkHref ? (
          <ChannelSourceLinkPill
            href={channelSourceLinkHref}
            channelId={channelHeaderChannelId}
          />
        ) : null}
        <ConversationAssetsPill
          assistantId={assistantId}
          conversationId={activeConversation.conversationId}
          refreshKey={assetsRefreshKey}
        />
      </>
    );
  }, [
    activeConversation?.conversationId,
    assistantId,
    assetsRefreshKey,
    channelSourceLinkHref,
    channelHeaderChannelId,
  ]);

  useEffect(() => {
    setTopBarRightSlot(topBarRightContent);
    return () => {
      setTopBarRightSlot(null);
    };
  }, [topBarRightContent, setTopBarRightSlot]);
}
