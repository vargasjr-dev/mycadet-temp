import { ArrowUp, Paperclip, Square } from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { flushSync } from "react-dom";
import { useNavigate } from "react-router";

import { PlusIcon } from "@/domains/chat/components/plus-icon";
import {
  AttachFileButton,
  ChatAttachmentsStrip,
} from "@/domains/chat/components/chat-attachments/chat-attachments";
import { useAttachmentFilePicker } from "@/domains/chat/components/chat-attachments/use-attachment-file-picker";
import { useCameraDeepLink } from "@/domains/chat/components/chat-attachments/use-camera-deep-link";
import {
  selectPathReferencePaths,
  selectUploadedIds,
  selectUploadingCount,
  useComposerStore,
} from "@/domains/chat/composer-store";
import { useQuoteReplyStore } from "@/domains/chat/quote-reply-store";
import { ComposerDraftNotices } from "@/domains/chat/components/composer-draft-notices";
import { nativeAttachmentPickersAvailable } from "@/domains/chat/components/chat-attachments/native-attachment-pickers";
import { AddToChatSheet } from "@/domains/chat/components/chat-composer/add-to-chat-sheet";
import { useComposerAttachmentPickers } from "@/domains/chat/components/chat-composer/use-composer-attachment-pickers";
import { StreamingWaveform } from "@/domains/chat/components/chat-composer/streaming-waveform";
import { useComposerConfigurationContext } from "@/domains/chat/components/composer-configuration-provider";
import { ComposerSettingsMenu } from "@/domains/chat/components/composer-settings-menu";
import {
  COMPOSER_MOBILE_RADIUS_CLASS,
  COMPOSER_RADIUS_CLASS,
  MOBILE_CONTROL_CLASS,
  MOBILE_GHOST_WASH_CLASS,
  MOBILE_GLYPH_CLASS,
  preventPressFocusTransfer,
} from "@/domains/chat/components/chat-composer/composer-mobile-chrome";
import { VoiceComposerBar } from "@/domains/chat/components/chat-composer/voice-composer-bar";
import { LiveVoiceButton } from "@/domains/chat/components/live-voice-button";
import { useSupportsLiveVoice } from "@/lib/backwards-compat/use-supports-live-voice";
import {
  VoiceInputButton,
  type VoiceInputButtonHandle,
} from "@/domains/chat/components/voice-input-button";
import { type TurnPhase, useTurnStore } from "@/domains/chat/turn-store";
import { endLiveVoiceSessionOnAssistant } from "@/domains/chat/voice/live-voice/live-voice-session-end-api";
import { navigateToConversation } from "@/utils/conversation-navigation";
import {
  dismissLiveVoiceFailure,
  endLiveVoiceSession,
  getLiveVoiceInputAmplitude,
  getLiveVoiceOutputAmplitude,
  isLiveVoiceSessionActive,
  isOnToolStep,
  restoreVoiceRoom,
  setLiveVoiceEntryOrigin,
  setLiveVoiceMuted,
  setLiveVoiceOutputMuted,
  useIsLiveVoiceSessionOwnedBy,
  useLiveVoiceStore,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import { voiceEntryGreetingSeed } from "@/domains/chat/voice/live-voice/voice-entry-greeting";
import {
  firstRunCardIntercepts,
  publishConfigNotice,
  voiceReadiness,
} from "@/domains/chat/voice/live-voice/voice-entry-guards";
import { useAudioAmplitude } from "@/domains/chat/voice/use-audio-amplitude";
import { VoiceFirstRunCard } from "@/domains/chat/voice/voice-room/voice-first-run-card";
import { useVoiceSurfacePaint } from "@/domains/chat/voice/voice-room/use-voice-surface-paint";
import { useVoiceRecordingStore } from "@/domains/chat/voice/voice-recording-store";
import { useVoicePrefsStore } from "@/stores/voice-prefs-store";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { isElectron } from "@/runtime/is-electron";
import { isPopoutWindowLifetime } from "@/runtime/popout-window";
import { useIsNativePlatform } from "@/runtime/native-auth";
import { isNativeIOS, useIsNativeAndroid } from "@/runtime/platform-detection";
import { isPointerCoarse, usePointerCoarse } from "@/utils/pointer";
import { routes } from "@/utils/routes";
import { useActiveAssistantIsSelfHosted } from "@/assistant/hosting";
import { useTranslation } from "@/i18n";
import { Button, cn, Notice, Popover } from "@mycadet/design-library";

import {
  computeGhostSuffix,
  isDraftPastOneLine,
  shouldSubmitOnEnter,
} from "@/domains/chat/components/chat-composer/chat-composer-utils";
import {
  EMOJI_MIN_FILTER_LENGTH,
  EMOJI_TRIGGER_RE,
  useEmojiSearch,
} from "@/domains/chat/components/chat-composer/emoji-catalog";
import type { EmojiEntry } from "./emoji-catalog-data";
import { EmojiPickerPopup } from "@/domains/chat/components/chat-composer/emoji-picker-popup";
import {
  applyMarkdownFormatting,
  matchFormattingShortcut,
} from "@/domains/chat/components/chat-composer/markdown-formatting";
import {
  SLASH_PREFIX_RE,
  type SlashCommand,
  filteredCommands,
  selectedInputText,
} from "@/domains/chat/components/chat-composer/slash-command-catalog";
import { SlashCommandPopup } from "@/domains/chat/components/chat-composer/slash-command-popup";
import { useTextPopup } from "@/domains/chat/components/chat-composer/use-text-popup";

/**
 * Composer for the chat thread (main variant) and the app-editing layout;
 * optional slots/voice props are the main variant's alone.
 */
export interface ChatComposerProps {
  placeholder?: string;
  onSubmit: (event: FormEvent) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  typingDisabled: boolean;
  sendDisabled: boolean;

  /**
   * Orchestration-owned: runs the vision-capability gate before queueing.
   */
  onAddAttachmentFiles: (files: FileList | File[]) => File[] | void;

  /** Omitting `voiceInputRef` skips the voice button (app-editing variant). */
  voiceInputRef?: RefObject<VoiceInputButtonHandle | null>;
  onVoiceTranscript?: (text: string) => void;
  onVoiceInterimTranscript?: (text: string) => void;
  /** Live partial transcript shown as ghost text below the waveform while recording. */
  voiceInterim?: string;
  onVoiceError?: (code: string | null) => void;
  onVoiceBeforeStart?: () => boolean | Promise<boolean>;
  /** Prepare the conversation's visible context before live voice can start a turn. */
  onBeforeLiveVoiceStart?: () => Promise<boolean>;

  onStopGenerating: () => void;
  /**
   * Whether the assistant is actively working (not waiting for user input).
   * Single source of truth shared with the avatar spinner. The composer must
   * not derive this locally because the turn store resets to idle on refresh.
   */
  isAssistantBusy: boolean;

  // assistant id used by AttachFileButton's disabled guard
  assistantId: string | null;

  /** Routing-truth conversation id for live-voice session binding. */
  conversationId?: string | null;

  /** Feeds `voiceEntryGreetingSeed`'s speak-first-on-blank-thread call. */
  conversationIsEmpty?: boolean;

  /** Chat status controls (Progress, Agents) above the mobile composer. */
  statusControlsSlot?: ReactNode;
  contextWindowIndicatorSlot?: ReactNode;
  /** Notices + live voice-interim preview, above the form. */
  noticesAboveFormSlot?: ReactNode;

  /** Drops the form's top radius so the billing banner sits flush. */
  hasBillingBanner?: boolean;

  /** Auto-grow height cap for the textarea. */
  textareaMaxHeightPx?: number;

  /** Cmd/Ctrl+Enter submits; plain Enter inserts a newline. */
  cmdEnterMode?: boolean;

  /** Ghost-text autocomplete suffix for the current conversation. */
  suggestion?: string | null;

  /** Up-arrow on empty input recalls the last user message. */
  onRecallLastMessage?: () => void;
  onCancelEdit?: () => void;
}

/**
 * Viewport-space center of the on-screen assistant avatar the live-voice room
 * grows its entrance from — the last on-screen `[data-voice-origin]` element
 * (the greeting avatar on a fresh chat, the latest-turn avatar in a
 * conversation). `null` when none is visible (falls back to the tapped button,
 * then screen-center).
 */
function measureVoiceOriginAvatar(): { x: number; y: number } | null {
  if (typeof document === "undefined") {
    return null;
  }
  let best: DOMRect | null = null;
  for (const node of document.querySelectorAll("[data-voice-origin]")) {
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      continue;
    }
    const onScreen =
      rect.bottom > 0 &&
      rect.top < window.innerHeight &&
      rect.right > 0 &&
      rect.left < window.innerWidth;
    // Keep the last on-screen one in DOM order (the most recent avatar).
    if (onScreen) {
      best = rect;
    }
  }
  if (!best) {
    return null;
  }
  return { x: best.left + best.width / 2, y: best.top + best.height / 2 };
}

/**
 * The padding the mobile text field carries on each side (`px-2`). Taken off
 * the span measured between the row's two control clusters, which is a border
 * box, to leave the width the draft itself gets on the inline row.
 */
const MOBILE_TEXT_FIELD_INSET_X_PX = 16;

interface AddToChatButtonProps {
  disabled: boolean;
  label: string;
  onClick: () => void;
  /** See `holdsFocusOnPress`. The row's other controls read the same signal. */
  onMouseDown?: (event: ReactMouseEvent<HTMLElement>) => void;
}

/** The narrow row's plus. What a press opens is the caller's decision. */
function AddToChatButton({
  disabled,
  label,
  onClick,
  onMouseDown,
}: AddToChatButtonProps) {
  return (
    <Button
      variant="ghost"
      iconOnly={<PlusIcon strokeWidth={2} />}
      iconOnlyGlyphClassName={MOBILE_GLYPH_CLASS}
      expandOnMobile={false} // the row sizes its own controls
      // Leave focus alone when the press can't carry it; the portal takes over.
      onMouseDown={onMouseDown}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      // Tertiary tone; `shrink-0` holds the circle at 40px.
      className={cn(
        MOBILE_CONTROL_CLASS,
        MOBILE_GHOST_WASH_CLASS,
        "shrink-0 [--vbtn-fg:var(--content-tertiary)]",
      )}
    />
  );
}

export function ChatComposer({
  placeholder = "What would you like to do?",
  onSubmit,
  inputRef,
  typingDisabled,
  sendDisabled: sendDisabledProp,
  onAddAttachmentFiles,
  voiceInputRef,
  onVoiceTranscript,
  onVoiceInterimTranscript,
  voiceInterim,
  onVoiceError,
  onVoiceBeforeStart,
  onBeforeLiveVoiceStart,
  onStopGenerating,
  isAssistantBusy,
  assistantId,
  conversationId,
  conversationIsEmpty = false,
  statusControlsSlot,
  contextWindowIndicatorSlot,
  noticesAboveFormSlot,
  hasBillingBanner = false,
  textareaMaxHeightPx = 240,
  cmdEnterMode = false,
  suggestion,
  onRecallLastMessage,
  onCancelEdit,
}: ChatComposerProps) {
  const { t } = useTranslation("chat");
  const configuration = useComposerConfigurationContext();
  const sendDisabled =
    sendDisabledProp || (configuration ? !configuration.readyForDraft : false);

  // Store subscription (not a prop) so a keystroke re-renders only this.
  const input = useComposerStore.use.input();
  const setInput = useComposerStore.use.setInput();
  // Attachments are composer-owned too: read the list and derive send-gating
  // here rather than threading four props down from the orchestrator.
  const attachments = useComposerStore.use.attachments();
  const removeAttachment = useComposerStore.use.removeAttachment();
  const attachmentsUploadingCount = selectUploadingCount(attachments);
  const canSendAttachments =
    attachmentsUploadingCount === 0 &&
    (selectUploadedIds(attachments).length > 0 ||
      selectPathReferencePaths(attachments).length > 0);

  const voicePhase = useVoiceRecordingStore.use.phase();
  const isVoiceActive =
    voicePhase === "recording" || voicePhase === "processing";
  // `hold` sessions (a held voice key in any app) are not ours to stop.
  const voiceHold = useVoiceRecordingStore.use.hold();
  const ownsDictation = isVoiceActive && !voiceHold;
  // Holds the MediaStream opened by VoiceInputButton so we can reuse it for
  // amplitude analysis rather than opening a second getUserMedia request.
  const [voiceStream, setVoiceStream] = useState<MediaStream | null>(null);
  const { amplitude } = useAudioAmplitude({
    active: voicePhase === "recording" && voiceStream !== null,
    stream: voiceStream,
  });
  const setVoiceAudioLevel = useVoiceRecordingStore.use.setAudioLevel();
  useEffect(() => {
    if (!voiceStream) {
      return;
    }
    setVoiceAudioLevel(amplitude);
  }, [amplitude, voiceStream, setVoiceAudioLevel]);
  const showVoiceInput =
    voiceInputRef !== undefined && onVoiceTranscript !== undefined;

  // ---- Live voice: entry is eligibility-gated; ChatLayout owns the controller ----
  const supportsLiveVoice = useSupportsLiveVoice(assistantId);
  const liveVoiceState = useLiveVoiceStore.use.state();
  const liveVoiceAssistantAudioActive =
    useLiveVoiceStore.use.assistantAudioActive();
  const liveVoiceResponsePhase = useLiveVoiceStore.use.responsePhase();
  const liveVoiceOnToolStep = useLiveVoiceStore(isOnToolStep);
  const liveVoiceError = useLiveVoiceStore.use.error();
  const liveVoiceErrorRecovery = useLiveVoiceStore.use.errorRecovery();
  // Any session live anywhere; `failed` counts as inactive.
  const isLiveVoiceSessionLive = isLiveVoiceSessionActive(liveVoiceState);
  // Owner of the active session (see `isLiveVoiceSessionOwnedBy`); blind to eligibility on purpose.
  const ownsLiveVoiceSession = useIsLiveVoiceSessionOwnedBy(conversationId);
  const isLiveVoiceActive = showVoiceInput && ownsLiveVoiceSession;
  // The bar paints from the session avatar — the same hook as the room and
  // pill, so the three can't disagree. The card underneath stays normal.
  const voiceSurfacePaint = useVoiceSurfacePaint();
  // The two mute states (controller-published) behind the block's toggles: one
  // per direction of the conversation, like the room's.
  const liveVoiceMuted = useLiveVoiceStore.use.muted();
  const liveVoiceOutputMuted = useLiveVoiceStore.use.outputMuted();
  // Textarea stays live during a session; speech lives in `VoiceAmbientTranscript`.
  const firstRunCardOpen = useLiveVoiceStore((state) => state.firstRunCardOpen);
  // Tap origin for the room's entrance animation (the first-run path defers).
  const liveVoiceEntryOriginRef = useRef<{ x: number; y: number } | null>(null);
  const navigate = useNavigate();
  // Window-lifetime read: the composer can remount after `?popout=1` drops.
  const isPopout = isPopoutWindowLifetime();
  // "Configure voice" copy from a `not-ready` preflight; non-null keeps the room closed.
  const voiceConfigNotice = useLiveVoiceStore((state) => state.configNotice);
  // Re-entrancy guard for the awaited preflight (ref: synchronous, no re-render).
  const liveVoicePreflightPendingRef = useRef(false);
  // Re-read after the preflight await, so a mid-flight chat switch can't bind the room to the old chat.
  const liveVoiceChatIdentityRef = useRef({
    assistantId,
    conversationId,
    conversationIsEmpty,
  });
  useEffect(() => {
    liveVoiceChatIdentityRef.current = {
      assistantId,
      conversationId,
      conversationIsEmpty,
    };
  }, [assistantId, conversationId, conversationIsEmpty]);
  const startLiveVoiceSession = useCallback(async () => {
    if (!assistantId || liveVoicePreflightPendingRef.current) {
      return;
    }
    // Prewarm the player inside the gesture — WebKit's playback permission is transient.
    const starter = useLiveVoiceStore.getState().starter;
    starter?.prewarm();
    // Gate on the daemon's readiness verdict (which also runs cloud-speech defaulting).
    liveVoicePreflightPendingRef.current = true;
    let readiness;
    try {
      readiness = await voiceReadiness(assistantId);
      if (
        readiness.allowed &&
        onBeforeLiveVoiceStart &&
        !(await onBeforeLiveVoiceStart())
      ) {
        starter?.cancelPrewarm();
        return;
      }
    } finally {
      liveVoicePreflightPendingRef.current = false;
    }
    // A mid-flight chat switch drops the result (and its notice) entirely.
    const latest = liveVoiceChatIdentityRef.current;
    if (
      latest.assistantId !== assistantId ||
      latest.conversationId !== conversationId
    ) {
      starter?.cancelPrewarm();
      return;
    }
    // The layout-owned controller may have unmounted while preflight was in
    // flight. Do not invoke a stale starter captured from the old mount.
    if (useLiveVoiceStore.getState().starter !== starter) {
      starter?.cancelPrewarm();
      return;
    }
    // Only an explicit `not-ready` closes the door (see `voiceReadiness`).
    if (!readiness.allowed) {
      starter?.cancelPrewarm();
      publishConfigNotice(readiness.notice);
      return;
    }
    publishConfigNotice(null);
    // Grow the entrance from the tagged `data-voice-origin` avatar; fallbacks: button, center.
    const origin =
      measureVoiceOriginAvatar() ?? liveVoiceEntryOriginRef.current;
    // Publish the origin BEFORE starting; the controller carries it across its
    // start-time `reset()` (see the live-voice store's `entryOrigin`).
    setLiveVoiceEntryOrigin(origin);
    // Read off `latest`: the preflight was a round trip; a filled thread opens silent, not abandoned.
    starter?.start(assistantId, conversationId ?? null, {
      entry: "composer",
      seedText: voiceEntryGreetingSeed(latest.conversationIsEmpty),
    });
  }, [assistantId, conversationId, onBeforeLiveVoiceStart]);
  /**
   * In-flight reclaim, so unmounting cancels it. The start on the far side of
   * the await reads this composer's chat identity, and a composer that has
   * unmounted stops updating it: its staleness check would compare the values
   * captured at unmount against itself, pass, and open a session for the page
   * the user left.
   */
  const liveVoiceReclaimRef = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      liveVoiceReclaimRef.current?.abort();
      liveVoiceReclaimRef.current = null;
    },
    [],
  );
  /**
   * Take the live-voice slot from the session that refused this one, and start
   * here. The blocking session is usually the same person on a surface they
   * cannot get back to, so the way out is to end it from here rather than to
   * go find it.
   */
  const handleReclaimLiveVoice = useCallback(async () => {
    if (!assistantId) {
      return;
    }
    // Prewarm inside the gesture; `startLiveVoiceSession` runs after a round trip.
    useLiveVoiceStore.getState().starter?.prewarm();
    const reclaim = new AbortController();
    liveVoiceReclaimRef.current?.abort();
    liveVoiceReclaimRef.current = reclaim;
    // Not branched on: the start handshake reports anything still wrong.
    await endLiveVoiceSessionOnAssistant(assistantId, reclaim.signal);
    if (liveVoiceReclaimRef.current === reclaim) {
      liveVoiceReclaimRef.current = null;
    }
    if (reclaim.signal.aborted) {
      return;
    }
    dismissLiveVoiceFailure();
    void startLiveVoiceSession();
  }, [assistantId, startLiveVoiceSession]);
  const handleGoToVoiceSession = useCallback(() => {
    const holderConversationId = liveVoiceErrorRecovery?.holderConversationId;
    if (!holderConversationId) {
      return;
    }
    dismissLiveVoiceFailure();
    navigateToConversation(navigate, holderConversationId);
  }, [liveVoiceErrorRecovery, navigate]);
  const handleLiveVoiceStart = useCallback(
    (origin?: { x: number; y: number }) => {
      if (!assistantId) {
        return;
      }
      liveVoiceEntryOriginRef.current = origin ?? null;
      // Drop focus only for the soft keyboard; everywhere else it stays put.
      if (isPointerCoarse()) {
        inputRef.current?.blur();
      }
      // First-run prefs card, every platform; dismissing cancels before `getUserMedia`.
      if (firstRunCardIntercepts()) {
        return;
      }
      startLiveVoiceSession();
    },
    [assistantId, inputRef, startLiveVoiceSession],
  );
  const handleFirstRunStart = useCallback(() => {
    useVoicePrefsStore.getState().markFirstRunSeen();
    useLiveVoiceStore.getState().setFirstRunCardOpen(false);
    startLiveVoiceSession();
  }, [startLiveVoiceSession]);

  const pointerCoarse = useMemo(() => isPointerCoarse(), []);

  // Row follows window width; what the plus opens follows the input.
  const isMobile = useIsMobile();
  const isNative = useIsNativePlatform();
  const isElectronHost = isElectron();

  const composerCardRef = useRef<HTMLFormElement>(null);

  // Stable ref so handleSlashCommandSelect's autoSend path always calls the
  // latest onSubmit even after flushSync triggers a synchronous re-render.
  const onSubmitRef = useRef(onSubmit);
  useLayoutEffect(() => {
    onSubmitRef.current = onSubmit;
  });

  // Cursor position for the emoji popup's trigger text.
  const cursorRef = useRef(input.length);

  // The Doctor is cloud-hosted only, so `/doctor` is not offered when the
  // active assistant is self-hosted (the Doctor tab doesn't exist there).
  const doctorGated = useActiveAssistantIsSelfHosted();
  const searchSlashCommands = useCallback(
    (filter: string) => {
      const commands = filteredCommands(filter);
      if (!doctorGated) {
        return commands;
      }
      return commands.filter((command) => command.name !== "doctor");
    },
    [doctorGated],
  );

  // Slash and emoji popups — state is derived from the input text, not stored.
  const slash = useTextPopup({
    text: input,
    trigger: SLASH_PREFIX_RE,
    search: searchSlashCommands,
  });

  // DOM-tracked via onSelect — state would re-render on every cursor move.
  // eslint-disable-next-line react-hooks/refs
  const textBeforeCursor = input.slice(0, cursorRef.current);
  const searchEmoji = useEmojiSearch();
  const emoji = useTextPopup({
    text: textBeforeCursor,
    trigger: EMOJI_TRIGGER_RE,
    search: searchEmoji,
    minFilterLength: EMOJI_MIN_FILTER_LENGTH,
  });

  const handleSlashCommandSelect = useCallback(
    (command: SlashCommand) => {
      const newInput = selectedInputText(command);
      if (command.selectionBehavior === "autoSend") {
        // Suppress before flushSync so the synchronous re-render derives
        // show=false instead of briefly flashing the popup.
        slash.dismiss();
        flushSync(() => setInput(newInput));
        onSubmitRef.current(new Event("submit") as unknown as FormEvent);
      } else {
        cursorRef.current = newInput.length;
        setInput(newInput);
        inputRef.current?.focus();
      }
    },
    [setInput, inputRef, slash.dismiss],
  );

  const insertEmoji = useCallback(
    (entry: EmojiEntry) => {
      const el = inputRef.current;
      const cursorPos = el?.selectionStart ?? input.length;
      const colonPos = cursorPos - emoji.filter.length - 1;
      const newInput =
        input.slice(0, colonPos) + entry.emoji + input.slice(cursorPos);
      const newCursor = colonPos + entry.emoji.length;
      cursorRef.current = newCursor;
      setInput(newInput);
      requestAnimationFrame(() => {
        if (el) {
          el.setSelectionRange(newCursor, newCursor);
          el.focus();
        }
      });
    },
    [emoji.filter, input, inputRef, setInput],
  );

  const phase: TurnPhase = useTurnStore.use.phase();
  const isLocallyGenerating =
    phase === "queued" || phase === "thinking" || phase === "streaming";
  const showInlineVoicePreview =
    isVoiceActive && !isLocallyGenerating && !isElectronHost;
  // Dictation's preview takes the textarea's place; a live session's bar doesn't.
  const hideTextareaForVoice = isNative && showInlineVoicePreview;
  // Staged context (quotes, the pinned channel ref) makes an empty input sendable.
  const hasStagedQuotes = useQuoteReplyStore.use.stagedQuotes().length > 0;
  const hasStagedContext = hasStagedQuotes;
  const canSendMessageContent =
    Boolean(input.trim()) || canSendAttachments || hasStagedContext;
  // Busy row keeps its shape; dictation Send = "finish, then send" (LUM-3432).
  const canSendOrFinishDictation = canSendMessageContent || ownsDictation;
  // One pressability answer for the slot's button and its Stop.
  const sendBlocked =
    sendDisabled || attachmentsUploadingCount > 0 || !canSendOrFinishDictation;
  // Stop takes the send slot exactly while there is no press to make; an owned
  // live-voice session keeps the slot as it rests.
  const showStopInSendSlot =
    isAssistantBusy && !isLiveVoiceActive && sendBlocked;
  // Voice mode occupies the send slot while there is nothing to send.
  const showDictationButton = showVoiceInput && !isLiveVoiceActive;
  // Suppressed during an owned live session — the bar above is the control.
  const showVoiceModeInSendSlot =
    showVoiceInput &&
    Boolean(assistantId) &&
    supportsLiveVoice &&
    !canSendOrFinishDictation &&
    !isLiveVoiceActive;

  // Only the main chat composer owns conversation configuration.
  const isMainComposer = Boolean(configuration);
  const isMobileMainComposer = isMobile && isMainComposer;

  // Not suppressed during a live session — the textarea is an ordinary input now.
  const ghostSuffix = useMemo(
    () =>
      computeGhostSuffix({
        pointerCoarse,
        suggestion: suggestion ?? null,
        input,
        hasAttachments: attachments.length > 0,
      }),
    [pointerCoarse, suggestion, input, attachments],
  );

  const [addSheetOpen, setAddSheetOpen] = useState(false);
  // Latched: the sheet closes before the OS picker opens, so a width flip can't strand it.
  const [addSheetEverPresented, setAddSheetEverPresented] = useState(false);
  const handleAddSheetOpenChange = useCallback((open: boolean) => {
    if (open) {
      setAddSheetEverPresented(true);
    }
    setAddSheetOpen(open);
  }, []);
  // Subscribed rather than read once: a convertible whose keyboard comes off
  // mid-session changes whether a press on the row carries focus with it.
  const pointerCoarseNow = usePointerCoarse();
  // Custom list for native-picker shells (Android needs `capture` + media accept).
  const isNativeAndroidShell = useIsNativeAndroid();
  const nativePickers = nativeAttachmentPickersAvailable();
  // iOS with native pickers uses the sheet at every width (WebKit's own menu steals the mic).
  const iosNativeAttach = isNativeIOS() && nativePickers;
  const usesAddSheet =
    iosNativeAttach || (isMobile && (isNativeAndroidShell || nativePickers));

  // Touch presses keep the textarea focused while activating a control.
  const holdsFocusOnPress = isMobile && pointerCoarseNow;
  // The handler form, for the controls this file renders itself. See
  // `preventPressFocusTransfer` for what the press would otherwise cost.
  const rowPressGuard = holdsFocusOnPress
    ? preventPressFocusTransfer
    : undefined;

  // One picker hook behind both attach controls, composer-owned so a width flip can't unmount it.
  const { openPicker: openAttachPicker, inputNode: attachPickerInput } =
    useAttachmentFilePicker({
      onFiles: onAddAttachmentFiles,
      multiple: true,
    });

  // The widget's camera; gated to `ChatMainPanel` so the tour can't spend it.
  const { overlayNode: cameraDeepLinkOverlay } = useCameraDeepLink({
    onFiles: onAddAttachmentFiles,
    enabled: isMainComposer,
  });

  // Banner presence, read off the box (the slot's notices are opaque nodes).
  const bannerStackRef = useRef<HTMLDivElement>(null);
  const [hasBannerAboveCard, setHasBannerAboveCard] = useState(false);
  const readBannerStack = useCallback(() => {
    const node = bannerStackRef.current;
    if (node) {
      setHasBannerAboveCard(node.childElementCount > 0);
    }
  }, []);
  // Every commit, so a banner settles in the same frame as its render.
  useLayoutEffect(readBannerStack);
  // Backstop for `ComposerDraftNotices`'s self-sourced state; `childList` only.
  useLayoutEffect(() => {
    const node = bannerStackRef.current;
    if (!node) {
      return;
    }
    const observer = new MutationObserver(readBannerStack);
    observer.observe(node, { childList: true });
    return () => {
      observer.disconnect();
    };
  }, [readBannerStack]);

  // Pill at mobile widths, 10px panel elsewhere; shares the live-voice bar's corners.
  const cardShapeClass = isMobile
    ? hasBillingBanner
      ? "rounded-b-[26px]"
      : COMPOSER_MOBILE_RADIUS_CLASS
    : hasBillingBanner
      ? "rounded-b-[10px]"
      : COMPOSER_RADIUS_CLASS;

  // 24px + 8px padding = the 40px the mobile buttons stand at; card stays 52px.
  const textFieldPaddingClass = isMobile ? "px-2 py-2" : "px-4 pt-3 pb-2";

  // ---- Mobile draft geometry: does the draft still fit its one line? ----
  const mobileRowRef = useRef<HTMLDivElement>(null);
  const inlineActionsStartRef = useRef<HTMLDivElement>(null);
  const inlineActionsEndRef = useRef<HTMLDivElement>(null);
  const draftProbeRef = useRef<HTMLDivElement>(null);
  const [isMultilineDraft, setIsMultilineDraft] = useState(false);
  const measureDraftGeometry = useCallback(() => {
    const start = inlineActionsStartRef.current;
    const end = inlineActionsEndRef.current;
    const probe = draftProbeRef.current;
    if (!isMobile || hideTextareaForVoice || !start || !end || !probe) {
      setIsMultilineDraft(false);
      return;
    }
    // The fixed span between control clusters — `isDraftPastOneLine`'s reference.
    const inlineWidthPx =
      end.getBoundingClientRect().left -
      start.getBoundingClientRect().right -
      MOBILE_TEXT_FIELD_INSET_X_PX;
    setIsMultilineDraft(
      isDraftPastOneLine({
        naturalWidthPx: probe.scrollWidth,
        inlineWidthPx,
        hasHardBreak: input.includes("\n"),
      }),
    );
  }, [hideTextareaForVoice, input, isMobile]);
  useLayoutEffect(() => {
    measureDraftGeometry();
  }, [measureDraftGeometry]);
  // Latest measurement behind a stable identity, so the observer below is set
  // up once per row rather than torn down and rebuilt on every keystroke.
  const measureDraftGeometryRef = useRef(measureDraftGeometry);
  useLayoutEffect(() => {
    measureDraftGeometryRef.current = measureDraftGeometry;
  });
  useEffect(() => {
    const row = mobileRowRef.current;
    const start = inlineActionsStartRef.current;
    const end = inlineActionsEndRef.current;
    if (!row || !start || !end || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() =>
      measureDraftGeometryRef.current(),
    );
    // The card's own width, and the two clusters it reserves room for: a turn
    // starting takes the plus away, which is 41px the draft gets back.
    observer.observe(row);
    observer.observe(start);
    observer.observe(end);
    return () => observer.disconnect();
  }, [isMobile]);

  // Mobile's plus opens the same picker/sheet as the paperclip; one availability gate.
  const attachDisabled = typingDisabled || !assistantId;
  const configurationPickers = useComposerAttachmentPickers({
    onOpenChange: configuration?.setOpen ?? handleAddSheetOpenChange,
    onAttachFiles: onAddAttachmentFiles,
  });
  const attachControl = configuration ? (
    <ComposerSettingsMenu
      configuration={configuration}
      disabled={attachDisabled}
      pickers={configurationPickers}
      onMouseDown={rowPressGuard}
    />
  ) : !isMobile && iosNativeAttach ? (
    // Paperclip chrome, sheet behind it. AttachFileButton's input is the
    // WebKit menu, and that menu's camera takes the microphone.
    <Button
      variant="ghost"
      iconOnly={<Paperclip />}
      onClick={() => handleAddSheetOpenChange(true)}
      disabled={attachDisabled}
      aria-label={t("chatAttachments.attachFileAria")}
      title={t("chatAttachments.attachFileAria")}
      className="[--vbtn-fg:var(--content-tertiary)] touch-mobile:[--vbtn-fg:var(--content-tertiary)]"
    />
  ) : !isMobile ? (
    <AttachFileButton
      disabled={attachDisabled}
      onFilesSelected={onAddAttachmentFiles}
    />
  ) : (
    <AddToChatButton
      disabled={attachDisabled}
      label={t("chatComposer.addToChat")}
      onClick={
        usesAddSheet ? () => handleAddSheetOpenChange(true) : openAttachPicker
      }
      onMouseDown={rowPressGuard}
    />
  );

  const dictationButton = showDictationButton ? (
    <VoiceInputButton
      ref={voiceInputRef}
      assistantId={assistantId}
      // A session in another thread blocks dictation (two mics can't run).
      disabled={typingDisabled || isLiveVoiceSessionLive}
      onTranscript={onVoiceTranscript}
      onInterimTranscript={onVoiceInterimTranscript}
      onError={onVoiceError}
      onBeforeStart={onVoiceBeforeStart}
      onStreamReady={setVoiceStream}
      mobileRow={isMobile}
      holdComposerFocus={holdsFocusOnPress}
    />
  ) : null;

  // The row's one Stop, in the send slot's chrome.
  const stopControl = (
    <Button
      variant="primary"
      iconOnly={<Square className="h-3 w-3" />}
      iconOnlyGlyphClassName={isMobile ? MOBILE_GLYPH_CLASS : undefined}
      expandOnMobile={!isMobile}
      onMouseDown={rowPressGuard}
      onClick={onStopGenerating}
      aria-label={t("chatComposer.stopGenerating")}
      className={isMobile ? MOBILE_CONTROL_CLASS : undefined}
    />
  );

  // Send stays through dictation: "finish, then send" (LUM-3432). Stop outranks.
  const sendSlot = showStopInSendSlot ? (
    stopControl
  ) : showVoiceModeInSendSlot ? (
    // Entry point; gives way to Send once a session starts here.
    <LiveVoiceButton
      onStart={handleLiveVoiceStart}
      disabled={typingDisabled || isVoiceActive || isLiveVoiceSessionLive}
      mobileRow={isMobile}
      holdComposerFocus={holdsFocusOnPress}
    />
  ) : (
    /* The assistant's accent at every width. A send nobody can press takes
       the variant's own disabled fill rather than a coloured control. */
    <Button
      variant="accent"
      iconOnly={<ArrowUp className="h-4 w-4" strokeWidth={2.5} />}
      iconOnlyGlyphClassName={isMobile ? MOBILE_GLYPH_CLASS : undefined}
      expandOnMobile={!isMobile}
      type="submit"
      onMouseDown={rowPressGuard}
      disabled={sendBlocked}
      title={
        sendDisabled || !canSendOrFinishDictation
          ? t("chatComposer.typeToSend")
          : attachmentsUploadingCount > 0
            ? t("chatComposer.uploadingAttachments")
            : t("chatComposer.sendMessage")
      }
      aria-label={t("chatComposer.sendMessage")}
      className={isMobile ? MOBILE_CONTROL_CLASS : undefined}
    />
  );

  const inlineVoicePreview = showInlineVoicePreview ? (
    // Non-Electron fallback (the overlay bridge no-ops outside Electron).
    <div
      className={hideTextareaForVoice ? "px-2 pt-3" : "px-2"}
      aria-label={
        voicePhase === "processing"
          ? t("chatComposer.transcribing")
          : t("chatComposer.recording")
      }
      aria-live="polite"
    >
      <StreamingWaveform
        amplitude={amplitude}
        paused={voicePhase === "processing"}
      />
      {voicePhase === "processing" ? (
        <p className="mt-1 truncate text-[11px] italic text-[var(--content-tertiary)]">
          {t("chatComposer.transcribingEllipsis")}
        </p>
      ) : (
        voiceInterim && (
          // Partial transcript ghost text, mirroring macOS composerTextField
          // showing interim results in the input binding while speaking.
          <p className="mt-1 truncate text-[11px] italic text-[var(--content-tertiary)]">
            {voiceInterim}
          </p>
        )
      )}
    </div>
  ) : null;

  // CSS Grid hidden-mirror autogrow (https://css-tricks.com/the-cleanest-trick-for-autogrowing-textareas/)
  // — no JS height measurement, so no WKWebView re-dispatch bug. One element serves both layouts.
  const textFieldBlock = (
    <div
      className={
        hideTextareaForVoice
          ? "hidden"
          : isMobile
            ? cn(
                "grid min-w-0",
                isMultilineDraft
                  ? // Past one line the block takes the row's whole width and
                    // The 2px lands the text on the card's 12px inset.
                    "order-first basis-full pl-0.5"
                  : "flex-1",
              )
            : "grid"
      }
    >
      {isMobile && (
        // Unwrapped `scrollWidth` measures the one-line fit (the mirror wraps);
        // the suggestion is deliberately excluded so the card never jumps.
        <div
          ref={draftProbeRef}
          aria-hidden
          data-slot="composer-draft-probe"
          className="pointer-events-none invisible col-start-1 row-start-1 h-0 w-0 overflow-hidden whitespace-pre text-chat"
          style={{ fontFamily: "inherit", letterSpacing: "inherit" }}
        >
          {input}
        </div>
      )}
      <div
        aria-hidden
        className={`pointer-events-none col-start-1 row-start-1 overflow-hidden whitespace-pre-wrap break-words text-chat ${textFieldPaddingClass}`}
        style={{
          fontFamily: "inherit",
          letterSpacing: "inherit",
          maxHeight: `${textareaMaxHeightPx}px`,
        }}
      >
        <span className="invisible">{input}</span>
        {ghostSuffix && (
          <span className="text-[var(--content-disabled)]">{ghostSuffix}</span>
        )}
        <span className="invisible"> </span>
      </div>
      <textarea
        ref={inputRef}
        value={input}
        autoComplete="off"
        data-1p-ignore
        data-lpignore="true"
        onChange={(e) => {
          const value = e.target.value;
          cursorRef.current = e.target.selectionStart ?? value.length;
          setInput(value);
          // An edit retires the "draft restored" marker.
          if (
            useComposerStore.getState().restoredDraftConversationId !== null
          ) {
            useComposerStore.getState().clearRestoredDraftNotice();
          }
        }}
        onPaste={(e) => {
          const items = e.clipboardData?.items;
          if (!items) {
            return;
          }
          const files: File[] = [];
          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item?.kind === "file") {
              const file = item.getAsFile();
              if (file) {
                files.push(file);
              }
            }
          }
          if (files.length > 0) {
            e.preventDefault();
            onAddAttachmentFiles(files);
          }
        }}
        onKeyDown={(e) => {
          if (slash.show) {
            if (e.key === "ArrowUp") {
              e.preventDefault();
              slash.moveUp();
              return;
            }
            if (e.key === "ArrowDown") {
              e.preventDefault();
              slash.moveDown();
              return;
            }
            if (e.key === "Tab" || e.key === "Enter") {
              e.preventDefault();
              const cmd = slash.items[slash.selectedIndex];
              if (cmd) {
                handleSlashCommandSelect(cmd);
              }
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              slash.dismiss();
              setInput("");
              return;
            }
          }

          if (emoji.show) {
            if (e.key === "ArrowUp") {
              e.preventDefault();
              emoji.moveUp();
              return;
            }
            if (e.key === "ArrowDown") {
              e.preventDefault();
              emoji.moveDown();
              return;
            }
            if (e.key === "Tab" || e.key === "Enter") {
              e.preventDefault();
              const selected = emoji.items[emoji.selectedIndex];
              if (selected) {
                insertEmoji(selected);
              }
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              emoji.dismiss();
              return;
            }
          }

          if (e.key === "ArrowUp" && !input.trim() && onRecallLastMessage) {
            e.preventDefault();
            onRecallLastMessage();
            return;
          }

          if (e.key === "Escape" && onCancelEdit) {
            e.preventDefault();
            onCancelEdit();
            return;
          }

          const marker = matchFormattingShortcut(e);
          if (marker) {
            e.preventDefault();
            const el = inputRef.current;
            const start = el?.selectionStart ?? input.length;
            const end = el?.selectionEnd ?? start;
            const result = applyMarkdownFormatting(input, start, end, marker);
            cursorRef.current = result.selectionStart;
            setInput(result.text);
            requestAnimationFrame(() => {
              if (el) {
                el.setSelectionRange(
                  result.selectionStart,
                  result.selectionEnd,
                );
                el.focus();
              }
            });
            return;
          }

          if (e.key === "Tab" && ghostSuffix) {
            e.preventDefault();
            const accepted = input + ghostSuffix;
            cursorRef.current = accepted.length;
            setInput(accepted);
            return;
          }
          const decision = shouldSubmitOnEnter(
            {
              key: e.key,
              shiftKey: e.shiftKey,
              metaKey: e.metaKey,
              ctrlKey: e.ctrlKey,
              isComposing: e.nativeEvent.isComposing,
              keyCode: e.keyCode,
            },
            pointerCoarse,
            {
              input,
              canSendAttachments,
              sendDisabled,
              attachmentsUploadingCount,
              cmdEnterMode,
              hasStagedContext,
              dictationInFlight: ownsDictation,
            },
          );
          if (decision === "ignore") {
            return;
          }
          e.preventDefault();
          if (decision === "submit") {
            onSubmit(e as unknown as FormEvent);
          }
        }}
        placeholder={ghostSuffix ? "" : placeholder}
        // A live-voice session leaves this alone — the bar above owns it.
        disabled={typingDisabled}
        rows={1}
        className={`col-start-1 row-start-1 w-full resize-none overflow-y-auto border-none bg-transparent text-chat text-[var(--content-default)] placeholder:text-[var(--content-disabled)] focus:outline-none disabled:opacity-50 ${textFieldPaddingClass}`}
        style={{ maxHeight: `${textareaMaxHeightPx}px` }}
      />
    </div>
  );

  return (
    <>
      {firstRunCardOpen && (
        // First entry only; dismiss cancels without consuming the first run.
        <VoiceFirstRunCard
          assistantId={assistantId}
          onStart={handleFirstRunStart}
          onDismiss={() =>
            useLiveVoiceStore.getState().setFirstRunCardOpen(false)
          }
        />
      )}
      {/* Every banner that stands over the card, in one watched box. While
          anything is in it the strip between the banner and the card is
          spoken for, and the two things that float in that strip (the mobile
          settings row below, and `ComposerPeek`'s avatar) stand down. */}
      <div ref={bannerStackRef} data-slot="composer-banner-stack">
        {/* Composer-owned draft/attachment notices (self-sourced), above the
            orchestration banner stack. */}
        <ComposerDraftNotices />
        {/* Live-voice failure notice, surfaced by the voice-enabled composer
            the user is looking at, mirroring the dictation `voiceError` Notice
            rendered by `ComposerNotices` in the orchestration stack below.
            Keyed on the session state (not entry eligibility) for the same
            reason as `isLiveVoiceActive`: a session that fails right after an
            eligibility drop must still surface its error. */}
        {showVoiceInput && liveVoiceState === "failed" && liveVoiceError && (
          <div className="mb-2">
            <Notice
              tone="error"
              onDismiss={dismissLiveVoiceFailure}
              actions={
                liveVoiceErrorRecovery?.kind === "reclaim" ? (
                  <>
                    <Button
                      variant="outlined"
                      size="compact"
                      onClick={() => {
                        void handleReclaimLiveVoice();
                      }}
                    >
                      {t("chatComposer.endOtherVoiceSession")}
                    </Button>
                    {/* Only when it is somewhere else: navigating to the
                        conversation already on screen would visibly do
                        nothing. */}
                    {liveVoiceErrorRecovery.holderConversationId && (
                      <Button
                        variant="ghost"
                        size="compact"
                        onClick={handleGoToVoiceSession}
                      >
                        {t("chatComposer.goToVoiceSession")}
                      </Button>
                    )}
                  </>
                ) : undefined
              }
            >
              {liveVoiceError}
            </Notice>
          </div>
        )}
        {/* Pre-open "configure voice" prompt, surfaced when the readiness
            preflight returns `not-ready` (no usable STT/TTS provider that
            couldn't be auto-configured). The room stays closed; the action
            deep-links to voice settings so the user can wire a provider. */}
        {showVoiceInput && voiceConfigNotice && (
          <div className="mb-2">
            <Notice
              tone="warning"
              onDismiss={() => publishConfigNotice(null)}
              actions={
                <Button
                  variant="outlined"
                  size="compact"
                  onClick={() => {
                    publishConfigNotice(null);
                    navigate(routes.settings.voice);
                  }}
                >
                  {t("chatComposer.configureVoice")}
                </Button>
              }
            >
              {voiceConfigNotice}
            </Notice>
          </div>
        )}
        {noticesAboveFormSlot}
      </div>
      {isLiveVoiceActive && (
        // The minimized session bar, above the card — ✕ ends, ⤢ grows back into the room.
        <div className="mb-2">
          <VoiceComposerBar
            state={liveVoiceState}
            assistantAudioActive={liveVoiceAssistantAudioActive}
            responsePhase={liveVoiceResponsePhase}
            onToolStep={liveVoiceOnToolStep}
            getAmplitude={getLiveVoiceInputAmplitude}
            getOutputAmplitude={getLiveVoiceOutputAmplitude}
            muted={liveVoiceMuted}
            onToggleMute={() => setLiveVoiceMuted(!liveVoiceMuted)}
            outputMuted={liveVoiceOutputMuted}
            onToggleOutputMute={() =>
              setLiveVoiceOutputMuted(!liveVoiceOutputMuted)
            }
            onEnd={endLiveVoiceSession}
            onExpand={isPopout ? undefined : restoreVoiceRoom}
            paint={voiceSurfacePaint}
          />
        </div>
      )}
      {/* `data-banner-above` is published for `ComposerPeek`, which reads the
          flag off this shell rather than watching the same stack a second
          time on its own clock. */}
      <div
        data-slot="chat-composer-shell"
        data-banner-above={hasBannerAboveCard ? "" : undefined}
        onKeyDownCapture={(event) => {
          if (
            configuration &&
            !attachDisabled &&
            (event.metaKey || event.ctrlKey) &&
            !event.altKey &&
            !event.shiftKey &&
            event.key.toLowerCase() === "u"
          ) {
            event.preventDefault();
            event.stopPropagation();
            configurationPickers.files();
          }
        }}
      >
        <>
          {isMobileMainComposer && (
            <div
              data-slot="composer-status-controls"
              className="mb-3 flex min-w-0 items-center gap-1.5 px-1.5 empty:mb-0"
            >
              {statusControlsSlot}
            </div>
          )}
          <Popover.Root open={emoji.show || slash.show}>
            <Popover.Anchor asChild>
              <form
                ref={composerCardRef}
                data-slot="chat-composer"
                onSubmit={onSubmit}
                className={`overflow-hidden bg-[var(--surface-lift)] shadow-[0px_2px_2px_rgba(0,0,0,0.05)] ${cardShapeClass}`}
              >
                {/* overflow-hidden lives here, not on the form itself: the form
                casts the shadow above, and overflow-hidden on the same box
                would clip that shadow along with the rounded corners. */}
                <div className={`overflow-hidden ${cardShapeClass}`}>
                  <ChatAttachmentsStrip
                    attachments={attachments}
                    onRemove={removeAttachment}
                    tileImages={isMobile}
                    pressGuard={rowPressGuard}
                  />
                  {isMobile ? (
                    <>
                      {inlineVoicePreview}
                      {/* One row: add, divider, input, mic, voice-or-send.
                        `items-end` holds the fixed-height controls on the
                        card's bottom edge while the textarea grows upward.
                        Once the draft outgrows that line the same row wraps:
                        the text takes the full width and the two control
                        clusters drop beneath it. Every control keeps its place
                        in this one flex container across the change, so the
                        textarea is never rebuilt under a caret mid-word. */}
                      <div
                        ref={mobileRowRef}
                        className={cn(
                          "flex items-end py-1.5 pl-0.5 pr-1.5",
                          // 4px + the field's 8px = the 12px to the controls.
                          isMultilineDraft && "flex-wrap gap-y-1",
                        )}
                      >
                        <div
                          ref={inlineActionsStartRef}
                          data-slot="composer-inline-actions-start"
                          className="flex shrink-0 items-end"
                        >
                          {contextWindowIndicatorSlot ? (
                            // Control-height so the slot centres against its glyphs.
                            <div className="mr-1 flex h-10 shrink-0 items-center">
                              {contextWindowIndicatorSlot}
                            </div>
                          ) : null}
                          {attachControl}
                          <div
                            aria-hidden="true"
                            className="-ml-0.5 mb-2 h-6 w-px shrink-0 bg-[var(--border-hover)]"
                          />
                        </div>
                        {textFieldBlock}
                        {/* The mic's 40x40 box carries 10px of slack around its
                          20px glyph, so 6px of gap lands that glyph the
                          design's 16px from the voice circle. `ml-auto` anchors
                          the group to the right end of whichever line it is
                          on: the wrapped control row, and the inline row once
                          native dictation has taken the textarea's `flex-1`
                          out of it. */}
                        <div
                          ref={inlineActionsEndRef}
                          data-slot="composer-inline-actions-end"
                          className="ml-auto flex shrink-0 items-end gap-1.5"
                        >
                          {dictationButton}
                          {sendSlot}
                        </div>
                      </div>
                    </>
                  ) : (
                    <>
                      {textFieldBlock}
                      {inlineVoicePreview}
                      {/* Attachments and settings sit on the left; voice and
                          send controls sit on the right. */}
                      <div className="flex items-center justify-between gap-1 px-2 pb-2">
                        <div className="flex min-w-0 items-center gap-2">
                          {contextWindowIndicatorSlot}
                          {attachControl}
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {dictationButton}
                          {sendSlot}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </form>
            </Popover.Anchor>
            <Popover.Content
              side="top"
              align="start"
              sideOffset={4}
              className="w-[var(--radix-popover-trigger-width)] rounded-none bg-transparent p-0 shadow-none"
              onOpenAutoFocus={(e: Event) => e.preventDefault()}
              onCloseAutoFocus={(e: Event) => e.preventDefault()}
              onInteractOutside={(e: Event) => e.preventDefault()}
              onEscapeKeyDown={(e: Event) => e.preventDefault()}
              onPointerDownOutside={(e: Event) => e.preventDefault()}
            >
              {emoji.show && (
                <EmojiPickerPopup
                  entries={emoji.items}
                  selectedIndex={emoji.selectedIndex}
                  onSelect={insertEmoji}
                />
              )}
              {slash.show && (
                <SlashCommandPopup
                  commands={slash.items}
                  selectedIndex={slash.selectedIndex}
                  onSelect={handleSlashCommandSelect}
                />
              )}
            </Popover.Content>
          </Popover.Root>
          {/* Beside the form, not inside it: a hidden file input stays mounted
              while a native picker is up, and has no business in the form the
              composer submits. Mounted whatever the row is showing, so a width
              or pointer change cannot pull it out from under an open picker.
              The hook lays the input out as `absolute inset-0`, so it needs a
              positioned box of its own. */}
          {!configuration && (
            <div className="relative">{attachPickerInput}</div>
          )}
          {/* The camera behind `deeplink.openCamera`. A `fixed inset-0`
              surface of its own rather than a hidden input, so it needs no box
              here, and rendered whether or not this composer offers a camera
              control: the command comes from outside the app. */}
          {cameraDeepLinkOverlay}
          {configuration && configurationPickers.inputs}
          {!configuration && (usesAddSheet || addSheetEverPresented) && (
            // The sheet's three inputs, latch-mounted so a width flip can't strand the pick.
            <AddToChatSheet
              open={addSheetOpen}
              onOpenChange={handleAddSheetOpenChange}
              onAttachFiles={onAddAttachmentFiles}
            />
          )}
        </>
      </div>
    </>
  );
}
