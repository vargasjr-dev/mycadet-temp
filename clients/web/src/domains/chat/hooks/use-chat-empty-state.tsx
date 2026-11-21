/**
 * Empty-state data for the chat — greeting text, the app-editing chips,
 * and the avatar render function.
 *
 * Composes the greeting query (`useEmptyStateGreeting`) and handles the
 * app-editing override where the greeting and the contextual chips are
 * derived from the opened app instead of the daemon.
 */

import { type ReactNode, useMemo } from "react";

import { ChatAvatar } from "@/components/avatar/chat-avatar";
import type { ChatEmptyStateProps } from "@/domains/chat/components/chat-empty-state";
import { ComposerPeek } from "@/domains/chat/components/composer-peek";
import { ConversationStarterGrid } from "@/domains/chat/components/conversation-starter-grid";
import { useEmptyStateGreeting } from "@/domains/chat/hooks/use-empty-state-greeting";
import {
  isLiveVoiceSessionActive,
  useLiveVoiceStore,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import {
  buildEditAppGreeting,
  buildEditAppStarters,
} from "@/domains/chat/utils/edit-app-empty-state";
import { pickRandomPlaceholder } from "@/domains/chat/utils/empty-state-constants";
import type { ConversationStarter } from "@/domains/chat/utils/conversation-starters";
import type { useAssistantAvatar } from "@/hooks/use-assistant-avatar";

// ---------------------------------------------------------------------------
// Params & return type
// ---------------------------------------------------------------------------

export interface UseChatEmptyStateParams {
  assistantId: string | null;
  /** Active empty conversation id — a change regenerates the greeting. */
  conversationId: string | null | undefined;
  isEmptyConversation: boolean;
  avatar: ReturnType<typeof useAssistantAvatar>;
  /** Current main view from viewer-store. */
  mainView: string;
  /** Opened app state from viewer-store (non-null when editing an app). */
  openedAppState: { name: string; dirName?: string } | null;
  isAssistantBusy: boolean;
  onSelectStarter: (starter: ConversationStarter) => void;
}

export interface ChatEmptyStateResult {
  emptyStateProps: ChatEmptyStateProps;
  /**
   * The app-editing side panel's contextual chips, rendered inline under
   * the composer. `undefined` on the plain empty state — it carries no
   * suggestion content.
   */
  startersSlot: ReactNode | undefined;
  renderAvatar: (() => ReactNode) | undefined;
  emptyStatePlaceholder: string;
  /**
   * The composer's hover peek for the empty state (see `ComposerPeek`):
   * mount it once alongside the chat body. `undefined` outside the plain
   * empty state (active conversation, app editing).
   */
  composerPeekSlot: ReactNode | undefined;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useChatEmptyState({
  assistantId,
  conversationId,
  isEmptyConversation,
  avatar,
  mainView,
  openedAppState,
  isAssistantBusy,
  onSelectStarter,
}: UseChatEmptyStateParams): ChatEmptyStateResult {
  const {
    components: avatarComponents,
    traits: avatarTraits,
    customImageUrl: avatarImageUrl,
  } = avatar;

  const emptyStatePlaceholder = useMemo(() => pickRandomPlaceholder(), []);
  const { greeting: emptyStateGreeting, isGenerating: greetingIsGenerating } =
    useEmptyStateGreeting({
      assistantId,
      conversationId,
      enabled: isEmptyConversation,
    });

  const editingApp =
    mainView === "app-editing" && openedAppState
      ? { name: openedAppState.name, dirName: openedAppState.dirName }
      : null;

  const isPlainEmptyState = isEmptyConversation && !editingApp;

  // The avatar's presence on the empty state lives entirely in
  // `ComposerPeek` (hanging from the top of the screen while idle in the
  // browser, saying hello from under the input on iOS, peeking behind the
  // input while it's focused on both). The greeting headline renders
  // alone.
  // Not during a live-voice session. The peek is anchored to the composer's
  // input rect, and a session replaces that input with the voice surface, so
  // the avatar it hangs has nothing left to peek out from. On mobile it is
  // worse than pointless: the peek is a `fixed` full-viewport portal, so its
  // top-of-screen avatar dangles into the band above the voice sheet, which
  // is the one part of the screen the sheet deliberately leaves to the thread
  // header.
  const liveVoiceState = useLiveVoiceStore.use.state();
  const actsEnabled =
    isPlainEmptyState && !isLiveVoiceSessionActive(liveVoiceState);

  const emptyStateProps: ChatEmptyStateProps = {
    greeting: editingApp
      ? buildEditAppGreeting(editingApp)
      : emptyStateGreeting,
    isGenerating: editingApp ? false : greetingIsGenerating,
  };

  // The app-editing side panel keeps its contextual chips inline under the
  // composer. They are derived from the opened app, so they are ready on
  // the first render.
  const emptyStateStarters = editingApp
    ? buildEditAppStarters(editingApp)
    : [];

  const startersSlot =
    isEmptyConversation && editingApp && emptyStateStarters.length > 0 ? (
      <div className="mt-4">
        <ConversationStarterGrid
          starters={emptyStateStarters}
          onSelect={onSelectStarter}
        />
      </div>
    ) : undefined;

  // Stable callback so the latest-turn avatar slot isn't rebuilt on every
  // transcript render. Paired with `memo(ChatAvatar)`, the avatar
  // re-renders only when its inputs actually change.
  const renderAvatar = useMemo(
    () =>
      avatarComponents || avatarImageUrl
        ? () => (
            <ChatAvatar
              components={avatarComponents}
              traits={avatarTraits}
              customImageUrl={avatarImageUrl}
              size={56}
              interactive
              isAssistantBusy={isAssistantBusy}
              // The latest-turn avatar below the most recent assistant
              // response — the room's entrance grows from here in a
              // conversation.
              originAnchor
            />
          )
        : undefined,
    [avatarComponents, avatarImageUrl, avatarTraits, isAssistantBusy],
  );

  // Portal component: mounting location doesn't matter, but it only runs
  // on the plain empty state (never over the app-editing side panel, whose
  // composer shares the same DOM anchor) and never during a live-voice
  // session (see `actsEnabled` above).
  const composerPeekSlot = actsEnabled ? (
    <ComposerPeek
      components={avatarComponents}
      traits={avatarTraits}
      active={actsEnabled}
    />
  ) : undefined;

  return {
    emptyStateProps,
    startersSlot,
    renderAvatar,
    emptyStatePlaceholder,
    composerPeekSlot,
  };
}
