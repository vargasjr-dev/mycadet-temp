/**
 * Conversation secondary actions — fork, open-in-new-window, copy
 * transcript, and share-feedback modal state.
 *
 * These are the "utility" actions surfaced in the conversation header chevron
 * menu and sidebar context menu. The primary CRUD-like actions (archive,
 * unarchive, delete, pin, rename, mark read/unread) live in `useConversationActions`.
 */

import { t } from "@/i18n";
import { copyToClipboard } from "@/lib/copy-to-clipboard";
import { captureError } from "@/lib/error-reporting/capture-error";
import { useCallback, useEffect, useRef } from "react";

import { useNavigate } from "react-router";
import { toast } from "@mycadet/design-library";

import type { Conversation } from "@/types/conversation-types";
import {
  conversationsByIdRetryPost,
  conversationsForkPost,
} from "@/generated/daemon/sdk.gen";
import { ApiError } from "@/utils/api-errors";
import { isElectron } from "@/runtime/is-electron";
import { openPopoutWindow } from "@/runtime/popout-window";
import { navigateToConversation } from "@/utils/conversation-navigation";
import { routes } from "@/utils/routes";
import { haptic } from "@/utils/haptics";
import { messagePlainText } from "@/domains/chat/utils/message-plain-text";
import { useTranscriptMessages } from "@/domains/chat/transcript/use-transcript-messages";
import type { DisplayMessage } from "@/domains/chat/types/types";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useConversationStore } from "@/stores/conversation-store";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

export interface UseConversationSecondaryActionsParams {
  activeConversation: Conversation | null | undefined;
  refreshConversations: () => void;
}

// ---------------------------------------------------------------------------
// Return
// ---------------------------------------------------------------------------

export interface UseConversationSecondaryActionsReturn {
  handleForkConversation: (throughMessageId: string) => Promise<void>;
  handleForkConversationFromMenu: () => void;
  handleRetryLatestTurn: () => Promise<void>;
  handleOpenInNewWindow: (conversation: Conversation) => void;
  handleCopyConversation: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useConversationSecondaryActions({
  activeConversation,
  refreshConversations,
}: UseConversationSecondaryActionsParams): UseConversationSecondaryActionsReturn {
  const navigate = useNavigate();

  // Fork / inspect / copy operate on the whole conversation. Mirror the derived
  // transcript into a ref so these callbacks can read the latest at call time
  // without taking it as a dependency (that would re-create them — and
  // re-register the header menu — on every streamed token).
  const transcript = useTranscriptMessages();
  const transcriptRef = useRef(transcript);
  useEffect(() => {
    transcriptRef.current = transcript;
  }, [transcript]);

  const handleForkConversation = useCallback(
    async (throughMessageId: string) => {
      const assistantId =
        useResolvedAssistantsStore.getState().activeAssistantId;
      const activeConversationId =
        useConversationStore.getState().activeConversationId;
      if (!assistantId || !activeConversationId) {
        return;
      }
      haptic.light();

      try {
        const { data } = await conversationsForkPost({
          path: { assistant_id: assistantId },
          body: { conversationId: activeConversationId, throughMessageId },
          throwOnError: true,
        });
        refreshConversations();
        // The haptic already fired at action start; silence the navigator's
        // own tap so forking doesn't double-buzz.
        navigateToConversation(navigate, data.conversation.id, {
          silent: true,
        });
      } catch (err) {
        captureError(err, { context: "fork_conversation" });
      }
    },
    [refreshConversations, navigate],
  );

  // Discards the latest assistant display turn and re-runs generation from
  // its user message. Fire-and-forget: the daemon acknowledges with 202, the
  // regenerated turn streams over the existing SSE events, and the discarded
  // rows disappear via the messages sync invalidation — no local state to
  // update here.
  const handleRetryLatestTurn = useCallback(async () => {
    const assistantId = useResolvedAssistantsStore.getState().activeAssistantId;
    const activeConversationId =
      useConversationStore.getState().activeConversationId;
    if (!assistantId || !activeConversationId) {
      return;
    }
    haptic.light();

    try {
      await conversationsByIdRetryPost({
        path: { assistant_id: assistantId, id: activeConversationId },
        throwOnError: true,
      });
    } catch (err) {
      captureError(err, { context: "retry_latest_turn" });
      toast.error(
        err instanceof ApiError && err.status === 409
          ? t("chat:useConversationSecondaryActions.assistantBusy")
          : t("chat:useConversationSecondaryActions.retryFailed"),
      );
    }
  }, []);

  const handleForkConversationFromMenu = useCallback(() => {
    const latestPersisted = transcriptRef.current.findLast((m) => m.id != null);
    const throughMessageId = latestPersisted?.id;
    if (!throughMessageId) {
      return;
    }
    void handleForkConversation(throughMessageId);
  }, [handleForkConversation]);

  const handleOpenInNewWindow = useCallback((conversation: Conversation) => {
    if (isElectron()) {
      void openPopoutWindow(conversation.conversationId);
    } else {
      window.open(routes.conversation(conversation.conversationId), "_blank");
    }
  }, []);

  const handleCopyConversation = useCallback(() => {
    const name = useAssistantIdentityStore.getState().name ?? "Assistant";
    const parts: string[] = [];
    if (activeConversation?.title) {
      parts.push(`# ${activeConversation.title}`);
    }
    for (const msg of transcriptRef.current) {
      const text = messagePlainText(msg);
      if (!text.trim()) {
        continue;
      }
      const sender = msg.role === "user" ? "You" : name;
      parts.push(`### ${sender}\n${text}`);
    }
    if (parts.length === 0) {
      return;
    }
    const markdown = parts.join("\n\n---\n\n");
    copyToClipboard(markdown, {
      successMessage: "Conversation copied to clipboard.",
      errorMessage: "Couldn't copy the conversation.",
    });
  }, [activeConversation?.title]);

  return {
    handleForkConversation,
    handleForkConversationFromMenu,
    handleRetryLatestTurn,
    handleOpenInNewWindow,
    handleCopyConversation,
  };
}
