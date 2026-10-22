// Pure projection from chat state onto the flat `TranscriptItem[]` list
// the virtualized transcript consumes. No React, no DOM — takes chat
// messages + interaction state and emits a flat item array that the
// Transcript component renders via a virtualised list.

import { getDesktopHelpEntry } from "@/domains/chat/desktop/desktop-help";
import type { PendingQuestionState } from "@/types/interaction-ui-types";
import type {
  DisplayMessage,
  EphemeralMetaResult,
} from "@/domains/chat/types/types";
import type {
  MessageItem,
  PendingContactRequestItem,
  TranscriptItem,
} from "@/domains/chat/transcript/types";

import { isCameraFrameRow } from "./camera-frame-rows";
import { getMessageRenderKind } from "./message-render-kind";

export interface BuildTranscriptItemsInput {
  messages: DisplayMessage[];
  pendingQuestion?: PendingQuestionState | null;
  pendingSecret: { requestId: string } | null;
  pendingConfirmation: { requestId: string } | null;
  pendingContactRequest?: {
    requestId: string;
    channel?: string;
    placeholder?: string;
    defaultValue?: string;
    label?: string;
    description?: string;
    role?: string;
  } | null;
  pendingContactRecordRequest?: { requestId: string } | null;
  isThinking: boolean;
  /**
   * Whether the assistant is busy on an in-flight turn at all (from
   * `isAssistantBusy`). While true, the thinking item is kept in the list even
   * when `isThinking` is false — rendered as an invisible fixed-height slot —
   * so the shimmering indicator fades in/out in place across the turn's
   * signal-ownership handoffs instead of inserting/removing a row (which read
   * as the transcript jumping). Omitted/false preserves the legacy behavior:
   * the item exists only while `isThinking`.
   */
  turnActive?: boolean;
  /** Daemon-provided activity label for the thinking indicator. */
  thinkingLabel?: string | null;
  /** Ephemeral local meta-command results (e.g. /clean, /status), rendered at
   *  the transcript tail. Not persisted; cleared on the next send/switch. */
  ephemeralMetaResults?: EphemeralMetaResult[];
  showOnboardingChoice?: boolean;
}

/**
 * Memoize the transcript item wrapper for a message by object identity.
 *
 * `buildTranscriptItems` re-runs on every streaming token (~20/sec). Without
 * memoization it mints a fresh `{ kind, key, message }` for every message,
 * defeating `TranscriptRow`'s `memo()` and re-rendering the entire list per
 * token. Caching by message ref means only the row whose message object
 * actually changed gets a new item — unchanged rows keep a stable reference
 * and skip rendering. Weak keys release naturally with their messages.
 *
 * The React `key` uses `clientMessageId ?? id` so the optimistic→server id
 * swap doesn't remount the row.
 */
const messageItemCache = new WeakMap<DisplayMessage, MessageItem>();
const cameraFrameItemCache = new WeakMap<DisplayMessage, MessageItem>();

function toMessageItem(
  message: DisplayMessage,
  cameraFrames?: DisplayMessage[],
): MessageItem {
  const frames = cameraFrames?.length ? cameraFrames : undefined;
  const cache = frames ? cameraFrameItemCache : messageItemCache;
  const cached = cache.get(message);
  if (
    cached &&
    (!frames ||
      (cached.cameraFrames?.length === frames.length &&
        frames.every((frame, index) => frame === cached.cameraFrames?.[index])))
  ) {
    return cached;
  }
  const item: MessageItem = {
    kind: "message",
    key: message.clientMessageId ?? message.id,
    message,
    ...(frames ? { cameraFrames: [...frames] } : {}),
  };
  cache.set(message, item);
  return item;
}

/**
 * Project the chat state into an ordered flat list of transcript items.
 *
 * Rules:
 *
 *   1. Hidden notifications and queued user rows neither render nor split runs.
 *      Consecutive camera frames join the next user row that renders normal
 *      user content. A visible incompatible row or list end leaves the run on
 *      its first frame. All source messages remain intact.
 *
 *   2. Items use `clientMessageId ?? id` for stable client identity and retain
 *      their references while their host and every grouped frame are unchanged.
 *      Inline surfaces and tool calls stay within the message body.
 *
 *   3. After the last message, emit trailers in this exact order:
 *        a. `ThinkingItem` when `isThinking`.
 *        b. `PendingSecretItem` when `pendingSecret` is set.
 *        c. `PendingConfirmationItem` when `pendingConfirmation` is set.
 * Every returned item carries a non-empty, distinct `key`.
 */
export function buildTranscriptItems(
  input: BuildTranscriptItemsInput,
): TranscriptItem[] {
  const {
    messages,
    pendingSecret,
    pendingConfirmation,
    pendingContactRequest,
    pendingContactRecordRequest,
    isThinking,
  } = input;

  const items: TranscriptItem[] = [];
  let pendingFrames: DisplayMessage[] = [];
  function flushPendingFrames(): void {
    if (pendingFrames.length > 0) {
      items.push(toMessageItem(pendingFrames[0]!, pendingFrames));
      pendingFrames = [];
    }
  }

  for (const message of messages) {
    // Daemon-injected run lifecycle notifications (subagent + ACP + any wake
    // trigger, i.e. user-role messages carrying subagentNotification /
    // acpNotification / backgroundEventNotification metadata) stay in `messages`
    // state so the LLM transcript and store rehydration still see them, but they
    // are internal scaffolding and are never rendered in the transcript — the run
    // surfaces through its inline card instead.
    if (
      message.isSubagentNotification ||
      message.isAcpNotification ||
      message.isBackgroundEventNotification
    ) {
      continue;
    }

    // Queued user messages surface via the queue drawer, not the transcript.
    const isQueuedUser =
      message.role === "user" && message.queueStatus === "queued";

    if (isQueuedUser) {
      continue;
    }

    if (getMessageRenderKind(message) === "user") {
      if (isCameraFrameRow(message)) {
        pendingFrames.push(message);
      } else {
        items.push(toMessageItem(message, pendingFrames));
        if (pendingFrames.length > 0) {
          pendingFrames = [];
        }
      }
      continue;
    }
    flushPendingFrames();
    items.push(toMessageItem(message));
  }
  flushPendingFrames();

  for (const result of input.ephemeralMetaResults ?? []) {
    items.push({
      kind: "ephemeralMeta",
      key: `meta-${result.id}`,
      result,
    });
  }

  if (isThinking || input.turnActive) {
    items.push({
      kind: "thinking",
      key: "thinking",
      active: isThinking,
      ...(input.thinkingLabel ? { label: input.thinkingLabel } : {}),
    });
  }

  if (input.pendingQuestion && getDesktopHelpEntry(input.pendingQuestion)) {
    items.push({
      kind: "pendingDesktopHelp",
      key: `desktop-help-${input.pendingQuestion.requestId}`,
      requestId: input.pendingQuestion.requestId,
    });
  }

  if (pendingSecret) {
    items.push({
      kind: "pendingSecret",
      key: `secret-${pendingSecret.requestId}`,
      requestId: pendingSecret.requestId,
    });
  }

  if (pendingConfirmation) {
    items.push({
      kind: "pendingConfirmation",
      key: `confirmation-${pendingConfirmation.requestId}`,
      requestId: pendingConfirmation.requestId,
    });
  }

  if (pendingContactRequest) {
    const item: PendingContactRequestItem = {
      kind: "pendingContactRequest",
      key: `contact-request-${pendingContactRequest.requestId}`,
      requestId: pendingContactRequest.requestId,
      channel: pendingContactRequest.channel,
      placeholder: pendingContactRequest.placeholder,
      defaultValue: pendingContactRequest.defaultValue,
      label: pendingContactRequest.label,
      description: pendingContactRequest.description,
      role: pendingContactRequest.role,
    };
    items.push(item);
  }

  if (pendingContactRecordRequest) {
    items.push({
      kind: "pendingContactRecordRequest",
      key: `contact-record-request-${pendingContactRecordRequest.requestId}`,
      requestId: pendingContactRecordRequest.requestId,
    });
  }

  if (input.showOnboardingChoice) {
    items.push({
      kind: "onboardingChoice",
      key: "onboarding-choice",
    });
  }

  return items;
}
