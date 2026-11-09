/**
 * The user's account profile, served through the assistant's gateway.
 *
 * The gateway proxies the platform's user-account surface with the
 * assistant's credentials (see `user-profile-proxy.ts` on the gateway), so
 * the web bundle dials the assistant API it already talks to instead of the
 * platform directly — the assistant tracks the user's profile for them.
 * Upstream DRF field-error bodies pass through the proxy verbatim, so the
 * 409-taken / 400-invalid handling below is unchanged.
 */
import {
  assistantUserMeGet,
  assistantUserMePartialUpdate,
  assistantUserUsernameAvailableGet,
} from "@/generated/gateway/sdk.gen";
import { getActiveAssistantId } from "@/stores/resolved-assistant-store";
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

export async function fetchMe(): Promise<UserMe> {
  const { data, error, response } = await assistantUserMeGet({
    path: { assistant_id: getActiveAssistantId() },
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

export async function updateMe(patch: UpdateMePatch): Promise<UpdateMeResult> {
  const { data, error, response } = await assistantUserMePartialUpdate({
    path: { assistant_id: getActiveAssistantId() },
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
  signal?: AbortSignal,
): Promise<UsernameAvailability> {
  const { data, error, response } = await assistantUserUsernameAvailableGet({
    path: { assistant_id: getActiveAssistantId() },
    query: { username },
    signal,
    throwOnError: false,
  });

  assertHasResponse(response, error, "Failed to check handle availability.");
  if (!response.ok || !data) {
    throw new ApiError(
      response.status,
      response.status === 429
        ? "Too many checks — try again in a moment."
        : extractErrorMessage(
            error,
            response,
            "Failed to check handle availability.",
          ),
    );
  }
  return data;
}
