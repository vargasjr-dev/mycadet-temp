import { routes } from "@/utils/routes";

const ONBOARDING_PREFIX = `${routes.assistant}/onboarding`;

const ROUTE_OWNED_TOP_INSET_PATHS: ReadonlySet<string> = new Set([
  routes.welcome,
]);

export function shouldDeferRootTopInset(
  pathname: string,
  search: string,
): boolean {
  if (
    pathname === ONBOARDING_PREFIX ||
    pathname.startsWith(`${ONBOARDING_PREFIX}/`) ||
    ROUTE_OWNED_TOP_INSET_PATHS.has(pathname)
  ) {
    return true;
  }

  return new URLSearchParams(search).get("onboarding") === "1";
}
