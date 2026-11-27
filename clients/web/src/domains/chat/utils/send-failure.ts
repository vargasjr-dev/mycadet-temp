import { resolvePostError } from "@/domains/chat/utils/send-message-utils";

export interface SendFailureClassification {
  title: string;
  message: string;
}

export function classifySendFailure(
  status: number | null | undefined,
  code: string | null | undefined,
  detail: string | undefined,
): SendFailureClassification {
  if (status === 502) {
    return {
      title: "Can't reach your assistant",
      message:
        "We couldn't reach your assistant just now. Check that it's awake and try again.",
    };
  }
  if (status === 503) {
    return {
      title: "Assistant unavailable",
      message:
        "Your assistant is starting up or temporarily busy. Try again in a moment.",
    };
  }
  if (status === 500 || status === 504) {
    return {
      title: "Unexpected assistant error",
      message:
        "Something unexpected went wrong at your assistant. Please try again.",
    };
  }
  return {
    title: "Message blocked",
    message: resolvePostError(
      code,
      detail,
      "Something went wrong. Please try again.",
    ),
  };
}
