import { resolveSignupCheckoutDestination } from "@app/lib/billing/post-auth-checkout";
import type { CheckoutHandoff } from "@app/lib/billing/checkout-intent";
import { routes } from "@app/utils/routes";

export interface NativePostAuthContext {
  returningUser: boolean;
  checkout: CheckoutHandoff;
}

/** Assistant onboarding facts are supplied by the composed client, never read here. */
export function resolveNativePostAuthDestination(
  intent: string | undefined,
  returnTo: string | null | undefined,
  context: NativePostAuthContext,
): string | null {
  const isSignup = intent === "signup";
  if (context.returningUser) {
    const [pathname, search = ""] = (returnTo ?? "").split(/[?#]/);
    const firstRun =
      new URLSearchParams(search).get("new_assistant") !== "1" &&
      [
        routes.onboarding.hosting,
        routes.onboarding.privacy,
        routes.onboarding.research,
      ].some((path) => path === pathname);
    const skipTarget = firstRun
      ? routes.assistant
      : (returnTo ?? (isSignup ? routes.assistant : null));
    resolveSignupCheckoutDestination(
      { intent: "login", returnTo: skipTarget ?? "" },
      context.checkout,
    );
    return skipTarget;
  }
  const destination = resolveSignupCheckoutDestination(
    {
      intent: isSignup ? "signup" : "login",
      returnTo: returnTo ?? "",
    },
    context.checkout,
  );
  return isSignup ? destination : (returnTo ?? null);
}

/** A later login clears an abandoned signup carry unless it resumes checkout. */
export function clearStaleNativeCheckoutStash(
  intent: string | undefined,
  returnTo: string | null | undefined,
  checkout: CheckoutHandoff,
): void {
  if (intent === "signup") {
    return;
  }
  resolveSignupCheckoutDestination(
    { intent: "login", returnTo: returnTo ?? "" },
    checkout,
  );
}
