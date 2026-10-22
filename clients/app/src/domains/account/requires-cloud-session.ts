import { requiresFullPageNavigation } from "@app/domains/account/full-page-navigation";
import { PLATFORM_ONLY_PATHS } from "@app/domains/account/session-destination-paths";

/** Whether a gateway identity is enough to reach the account entry's destination. */
export function requiresCloudSession(destination: string): boolean {
  if (requiresFullPageNavigation(destination)) return true;
  const path = destination.split(/[?#]/)[0] ?? destination;
  return PLATFORM_ONLY_PATHS.some(
    (candidate) => path === candidate || path.startsWith(`${candidate}/`),
  );
}
