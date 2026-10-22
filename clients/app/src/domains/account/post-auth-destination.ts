import { requiresFullPageNavigation } from "@app/domains/account/full-page-navigation";
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
      const realWork = url.searchParams.get("new_assistant") === "1";
      if (
        !realWork &&
        [routes.onboarding.privacy, routes.onboarding.research].some(
          (path) => path === url.pathname,
        )
      ) {
        destination = fallback;
      }
    } else if (authIntent === "signup") {
      // A first-run signup routes through consent (privacy) first.
      destination = routes.onboarding.privacy;
    }
  }
  return {
    destination,
    requiresFullPageNavigation: requiresFullPageNavigation(destination),
  };
}
