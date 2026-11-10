import {
  assistantUserMeGet,
  assistantUserMePartialUpdate,
} from "@/generated/gateway/sdk.gen";
import {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/utils/api-errors";
import { parseDrfFieldError } from "./parse-drf-field-error";

export interface UserMe {
  id: string;
  username: string;
  email: string;
  first_name: string;
  last_name: string;
}

export type UsernameErrorCode =
  | "too_short"
  | "too_long"
  | "invalid_chars"
  | "leading_underscore"
  | "trailing_underscore"
  | "leading_hyphen"
  | "trailing_hyphen"
  | "all_digits"
  | "reserved"
  | "taken";

export interface UsernameAvailability {
  available: boolean;
  code: UsernameErrorCode | null;
  message: string | null;
}

export const USERNAME_ERROR_COPY: Record<UsernameErrorCode, string> = {
  too_short: "Must be at least 3 characters.",
  too_long: "Must be at most 30 characters.",
  invalid_chars:
    "Use only lowercase letters, digits, hyphens, and underscores.",
  leading_underscore: "Cannot start with an underscore.",
  trailing_underscore: "Cannot end with an underscore.",
  leading_hyphen: "Cannot start with a hyphen.",
  trailing_hyphen: "Cannot end with a hyphen.",
  all_digits: "Cannot be all digits.",
  reserved: "This handle is reserved.",
  taken: "This handle is already taken.",
};

export async function fetchMe(assistantId: string): Promise<UserMe> {
  const { data, error, response } = await assistantUserMeGet({
    path: { assistant_id: assistantId },
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to load profile.");
  if (!response.ok || !data) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to load profile."),
    );
  }
  return data;
}

export interface UpdateMePatch {
  username?: string;
}

export type UpdateMeResult =
  | { kind: "ok"; data: UserMe }
  | { kind: "taken"; message: string }
  | { kind: "invalid"; code: UsernameErrorCode | null; message: string }
  | { kind: "error"; message: string };

const DEFAULT_USERNAME_ERROR = "Please choose a different handle.";

export async function updateMe(
  assistantId: string,
  patch: UpdateMePatch,
): Promise<UpdateMeResult> {
  const { data, error, response } = await assistantUserMePartialUpdate({
    path: { assistant_id: assistantId },
    body: patch,
    throwOnError: false,
  });

  if (!response) {
    return {
      kind: "error",
      message:
        extractErrorMessage(error, undefined, "Failed to save profile.") ??
        "Failed to save profile.",
    };
  }

  if (response.ok && data) {
    return { kind: "ok", data };
  }

  if (response.status === 409) {
    const { message } = parseDrfFieldError(
      error,
      "username",
      USERNAME_ERROR_COPY.taken,
    );
    return { kind: "taken", message };
  }

  if (response.status === 400) {
    const { code, message } = parseDrfFieldError(
      error,
      "username",
      DEFAULT_USERNAME_ERROR,
    );
    return { kind: "invalid", code: code as UsernameErrorCode | null, message };
  }

  return {
    kind: "error",
    message: extractErrorMessage(error, response, "Failed to save profile."),
  };
}

export async function checkUsernameAvailable(
  username: string,
  _signal?: AbortSignal,
): Promise<UsernameAvailability> {
  // Availability is an operator api (single-user assumption: mostly true).
  // The web card checks the format locally against the same canonical
  // codes; the gateway's profile patch enforces them again on save.
  const code = checkUsernameFormat(username);
  if (!code) {
    return { available: true, code: null, message: null };
  }
  return { available: false, code, message: USERNAME_ERROR_COPY[code] };
}

function checkUsernameFormat(username: string): UsernameErrorCode | null {
  if (username.length < 3) {
    return "too_short";
  }
  if (username.length > 30) {
    return "too_long";
  }
  if (/[^a-z0-9_-]/.test(username)) {
    return "invalid_chars";
  }
  if (username.startsWith("_")) {
    return "leading_underscore";
  }
  if (username.endsWith("_")) {
    return "trailing_underscore";
  }
  if (username.startsWith("-")) {
    return "leading_hyphen";
  }
  if (username.endsWith("-")) {
    return "trailing_hyphen";
  }
  if (/^[0-9]+$/.test(username)) {
    return "all_digits";
  }
  return null;
}
