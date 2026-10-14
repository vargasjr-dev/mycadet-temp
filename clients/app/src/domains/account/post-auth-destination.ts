import type { AuthCallbackIntent } from "@app/domains/account/provider-callback";
import type { CheckoutHandoff } from "@app/lib/billing/checkout-intent";
import { resolveSignupCheckoutDestination } from "@app/lib/billing/post-auth-checkout";
import { requiresFullPageNavigation } from "@app/domains/account/full-page-navigation";
import {
  isImportFunnelDestination,
  shouldSkipFirstRunDestination,
} from "@app/domains/account/post-auth-return-policy";
import { sanitizeReturnTo } from "@app/utils/return-to";

export interface PostAuthDestination {
  destination: string;
  requiresFullPageNavigation: boolean;
}
export interface PostAuthContext {
  returningUser: boolean;
  checkout: CheckoutHandoff;
}
export function resolvePostAuthDestination(
  args: {
    returnTo: string | null;
    fallback: string;
    authIntent: AuthCallbackIntent;
  },
  context: PostAuthContext,
): PostAuthDestination {
  let destination = sanitizeReturnTo(args.returnTo, args.fallback);
  if (args.authIntent === "signup" && isImportFunnelDestination(destination)) {
    return { destination, requiresFullPageNavigation: true };
  }
  if (context.returningUser) {
    if (shouldSkipFirstRunDestination(destination)) {
      destination = args.fallback;
    }
    resolveSignupCheckoutDestination(
      { intent: "login", returnTo: destination },
      context.checkout,
    );
  } else {
    destination = resolveSignupCheckoutDestination(
      { intent: args.authIntent, returnTo: destination },
      context.checkout,
    );
  }
  return {
    destination,
    requiresFullPageNavigation: requiresFullPageNavigation(destination),
  };
}
