/**
 * Assembles the queued-message ReactNode slot that {@link ChatBody} renders
 * in the main chat panel.
 *
 * Factored out of the orchestrator so the slot construction logic is
 * testable independently and the orchestrator stays focused on wiring.
 */

import { type ReactNode, useMemo } from "react";

import { QueuedMessagesDrawer } from "@/domains/chat/components/queued-messages-drawer";
import type { DisplayMessage } from "@/domains/chat/types/types";

// ---------------------------------------------------------------------------
// Params & return type
// ---------------------------------------------------------------------------

export interface UseChatBannerSlotsParams {
  queuedMessages: DisplayMessage[];
  onCancelQueuedMessage: (messageId: string) => void;
  onCancelAllQueued: () => void;
  onSteerMessage: (messageId: string) => void;
  onEditQueueTail: () => void;
}

export interface ChatBannerSlots {
  mainQueuedDrawerSlot: ReactNode;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useChatBannerSlots({
  queuedMessages,
  onCancelQueuedMessage,
  onCancelAllQueued,
  onSteerMessage,
  onEditQueueTail,
}: UseChatBannerSlotsParams): ChatBannerSlots {
  const mainQueuedDrawerSlot = useMemo(
    (): ReactNode => (
      <QueuedMessagesDrawer
        queuedMessages={queuedMessages}
        onCancelMessage={onCancelQueuedMessage}
        onCancelAll={onCancelAllQueued}
        onSteer={onSteerMessage}
        onEditTail={onEditQueueTail}
      />
    ),
    [
      queuedMessages,
      onCancelQueuedMessage,
      onCancelAllQueued,
      onSteerMessage,
      onEditQueueTail,
    ],
  );

  return { mainQueuedDrawerSlot };
}
