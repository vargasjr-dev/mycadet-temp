// Chat error codes the notice layer reasons about directly: a
// not-configured provider hides the generic inline notice (its own card
// owns the surface), and a cloud credential error pins a dedicated notice.
const PROVIDER_NOT_CONFIGURED_CODE = "PROVIDER_NOT_CONFIGURED";
const MANAGED_KEY_INVALID_CODE = "MANAGED_KEY_INVALID";

export interface ChatErrorLike {
  code?: string;
  errorCategory?: string;
  /**
   * When set to "modal" the error is rendered as a blocking dialog instead
   * of an inline banner. Suppress the generic inline Notice in that case.
   */
  displayAs?: "inline" | "modal";
}

export function shouldSuppressGenericChatErrorNotice(
  error: ChatErrorLike | null | undefined,
): boolean {
  return (
    error?.code === PROVIDER_NOT_CONFIGURED_CODE || error?.displayAs === "modal"
  );
}

export function shouldShowGenericChatErrorNotice(
  error: ChatErrorLike | null | undefined,
): boolean {
  return !!error && !shouldSuppressGenericChatErrorNotice(error);
}

export function isCloudCredentialChatError(
  error: ChatErrorLike | null | undefined,
): boolean {
  return error?.code === MANAGED_KEY_INVALID_CODE;
}
