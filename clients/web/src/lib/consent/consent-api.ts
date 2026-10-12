import {
  userConsentRetrieve,
  userConsentUpdate,
} from "@/generated/api/sdk.gen";
import type { UserConsent as GeneratedUserConsent } from "@/generated/api/types.gen";
import {
  ApiError,
  assertHasResponse,
  extractErrorMessage,
} from "@/utils/api-errors";

/**
 * The generated wire type, tightened for reads: DRF serializes every field on
 * a GET (the generated optionality is write-side schema conservatism). Tying
 * this to the generated contract means a field that doesn't exist on the
 * server fails the build instead of silently reading `undefined`. The share
 * booleans are null until the user makes an explicit choice.
 */
export type UserConsent = Required<GeneratedUserConsent>;

export type ConsentPatch = Partial<
  Omit<
    UserConsent,
    | "tos_accepted_at"
    | "privacy_policy_accepted_at"
    | "ai_data_sharing_accepted_at"
    | "share_analytics_accepted_at"
    | "share_diagnostics_accepted_at"
  >
>;

export async function fetchConsent(): Promise<UserConsent> {
  const { data, error, response } = await userConsentRetrieve({
    throwOnError: false,
  });
  assertHasResponse(response, error, "Failed to load consent.");
  if (!response.ok || !data) {
    throw new ApiError(
      response.status,
      extractErrorMessage(error, response, "Failed to load consent."),
    );
  }
  // Safe: DRF serializes every field on a read; see the UserConsent alias.
  return data as UserConsent;
}

// PUTs /v1/user/consent/ — partial bodies are accepted, no writable field is required.
export async function patchConsent(consent: ConsentPatch): Promise<void> {
  await userConsentUpdate({
    body: consent,
    throwOnError: true,
  });
}
