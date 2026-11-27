import { ERROR_MESSAGES } from "@/domains/chat/utils/chat";

import { resolvePostError } from "@/domains/chat/utils/send-message-utils";

/**
 * Send-failure classification: turn the POST's HTTP status (carried on
 * `PostMessageResult` when `ok: false`) into the copy the send path
 * renders. Two axes matter and they must NOT collapse into one UX:
 *
 * - 4xx rejections (policy/validation, e.g. the daemon's `secret_blocked`
 *   422) genuinely blocked the message — the modal's "Message blocked"
 *   framing is honest there.
 * - 5xx (and auth failures at the assistant/LLM boundary) are NOT message
 *   rejections: 5xx means we couldn't reach or the assistant stumbled, and
 *   a 401/403 means the assistant answered but its model access failed.
 *   Those get their own copy — and the auth case keeps the optimistic
 *   message + conversation alive so the provider error renders as an
 *   assistant message (the usual provider-error surface) instead of
 *   pretending the user's message was rejected.
 */
export interface SendFailureClassification {
  /** The modal's title when the failure renders as a dialog. */
  title: string;
  /** The user-facing message body. */
  message: string;
  /**
   * When true the send path keeps the optimistic conversation + user
   * message (and surfaces the failure as an assistant message) instead of
   * rolling back — the failure is about the assistant's model access, not
   * the user's message.
   */
  keepMessageAndConversation: boolean;
}

const AUTH_STATUSES = new Set([401, 403]);

export function classifySendFailure(
  status: number | null | undefined,
  code: string | null | undefined,
  detail: string | undefined,
): SendFailureClassification {
  if (status !== undefined && status !== null && AUTH_STATUSES.has(status)) {
    return {
      title: "Assistant couldn't respond",
      message:
        (code && ERROR_MESSAGES[code]) ||
        detail ||
        "Your assistant couldn't reach its model provider. Check the assistant's API keys and try again.",
      keepMessageAndConversation: true,
    };
  }
  if (status === 502) {
    return {
      title: "Can't reach your assistant",
      message:
        "We couldn't reach your assistant just now. Check that it's awake and try again.",
      keepMessageAndConversation: false,
    };
  }
  if (status === 503) {
    return {
      title: "Assistant unavailable",
      message:
        "Your assistant is starting up or temporarily busy. Try again in a moment.",
      keepMessageAndConversation: false,
    };
  }
  if (status === 500 || status === 504) {
    return {
      title: "Unexpected assistant error",
      message:
        "Something unexpected went wrong at your assistant. Please try again.",
      keepMessageAndConversation: false,
    };
  }
  // 4xx rejections and unknown failures keep the existing framing — a real
  // "the message was not accepted" case, or a legacy response with no
  // status to classify.
  return {
    title: "Message blocked",
    message: resolvePostError(
      code,
      detail,
      "Something went wrong. Please try again.",
    ),
    keepMessageAndConversation: false,
  };
}
