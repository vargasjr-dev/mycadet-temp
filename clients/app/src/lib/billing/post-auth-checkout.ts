import { parseCustomCheckoutSelection } from "@app/lib/billing/custom-checkout-params";
import {
  signupCheckoutIntent,
  type CheckoutHandoff,
} from "@app/lib/billing/checkout-intent";
import { routes } from "@app/utils/routes";

export function resolveSignupCheckoutDestination(
  args: { intent: "login" | "signup"; returnTo: string },
  handoff: CheckoutHandoff,
): string {
  let checkout: Parameters<typeof signupCheckoutIntent>[0] | null = null;
  try {
    const url = new URL(args.returnTo, "http://placeholder.invalid");
    if (url.pathname === routes.checkout) {
      const packageKey = url.searchParams.get("package");
      const selection = parseCustomCheckoutSelection(url.searchParams);
      checkout = packageKey
        ? { kind: "package", packageKey }
        : selection
          ? { kind: "custom", ...selection }
          : null;
    }
  } catch {
    // An invalid destination carries no checkout selection.
  }
  if (!checkout) {
    handoff.clear();
  }
  if (args.intent === "signup") {
    if (checkout) {
      handoff.save(signupCheckoutIntent(checkout));
    }
    return routes.onboarding.privacy;
  }
  return args.returnTo;
}
