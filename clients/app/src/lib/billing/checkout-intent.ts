import type { CustomCheckoutSelection } from "@app/lib/billing/custom-checkout-params";

export type SignupCheckoutIntent = (
  | { kind: "package"; packageKey: string }
  | ({ kind: "custom" } & CustomCheckoutSelection)
) & { resumeAfterOnboarding: true };

/** The composed client shares the stash and its in-memory fallback with web. */
export interface CheckoutHandoff {
  save(intent: SignupCheckoutIntent): void;
  clear(): void;
}

/** Mark signup selections so only the assistant's consent screen resumes them. */
export function signupCheckoutIntent(
  selection:
    | { kind: "package"; packageKey: string }
    | ({ kind: "custom" } & CustomCheckoutSelection),
): SignupCheckoutIntent {
  return { ...selection, resumeAfterOnboarding: true };
}
