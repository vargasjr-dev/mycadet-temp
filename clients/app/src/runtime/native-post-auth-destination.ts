import { routes } from "@app/utils/routes";

export interface NativePostAuthContext {
  returningUser: boolean;
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
        routes.account.onboarding.hosting,
        routes.onboarding.privacy,
        routes.onboarding.research,
      ].some((path) => path === pathname);
    return firstRun
      ? routes.assistant
      : (returnTo ?? (isSignup ? routes.assistant : null));
  }
  return isSignup ? routes.onboarding.privacy : (returnTo ?? null);
}
