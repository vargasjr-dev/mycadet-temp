import { resolveSignupCheckoutDestination } from "@app/lib/billing/post-auth-checkout";
import { checkoutHandoff } from "@app/lib/billing/checkout-intent-storage";
import { requiresFullPageNavigation } from "@app/domains/account/full-page-navigation";
import { isPaidProvisioningReturn } from "@app/domains/account/paid-provisioning-return";
import { sanitizeReturnTo } from "@app/utils/return-to";
import { routes } from "@app/utils/routes";

export function resolvePostAuthDestination({
  returnTo,
  fallback,
  authIntent,
  returningUser,
}: {
  returnTo: string | null;
  fallback: string;
  authIntent: "login" | "signup";
  returningUser: boolean;
}): { destination: string; requiresFullPageNavigation: boolean } {
  let destination = sanitizeReturnTo(returnTo, fallback);
  const importSignup =
    authIntent === "signup" &&
    (destination === "/import" ||
      destination.startsWith("/import?") ||
      destination.startsWith("/import/"));
  if (!importSignup) {
    if (returningUser) {
      const url = new URL(destination, "http://placeholder.invalid");
      const realWork =
        isPaidProvisioningReturn(destination) ||
        url.searchParams.get("new_assistant") === "1";
      if (
        !realWork &&
        [routes.onboarding.privacy, routes.onboarding.research].some(
          (path) => path === url.pathname,
        )
      ) {
        destination = fallback;
      }
      resolveSignupCheckoutDestination(
        { intent: "login", returnTo: destination },
        checkoutHandoff,
      );
    } else {
      destination = resolveSignupCheckoutDestination(
        { intent: authIntent, returnTo: destination },
        checkoutHandoff,
      );
    }
  }
  return {
    destination,
    requiresFullPageNavigation: requiresFullPageNavigation(destination),
  };
}
