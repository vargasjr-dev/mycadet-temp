import { requiresFullPageNavigation } from "@app/domains/account/full-page-navigation";
import { PLATFORM_ONLY_PATHS } from "@app/domains/account/session-destination-paths";
import { isPostCheckoutReturn } from "@app/domains/account/checkout-return";
import { isPaidProvisioningReturn } from "@app/domains/account/paid-provisioning-return";

/** Whether a gateway identity is enough to reach the account entry's destination. */
export function requiresCloudSession(destination: string): boolean {
  if (requiresFullPageNavigation(destination)) return true;
  const path = destination.split(/[?#]/)[0] ?? destination;
  if (
    PLATFORM_ONLY_PATHS.some(
      (candidate) => path === candidate || path.startsWith(`${candidate}/`),
    )
  )
    return true;
  return (
    isPaidProvisioningReturn(destination) || isPostCheckoutReturn(destination)
  );
}
