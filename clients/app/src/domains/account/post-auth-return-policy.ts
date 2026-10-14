import { isPaidProvisioningReturn } from "@app/domains/account/paid-provisioning-return";
import { routes } from "@app/utils/routes";

export function isImportFunnelDestination(destination: string): boolean {
  return (
    destination === "/import" ||
    destination.startsWith("/import?") ||
    destination.startsWith("/import/")
  );
}

/** Returning users keep purchase returns and explicit new-assistant walks. */
export function shouldSkipFirstRunDestination(destination: string): boolean {
  const qIdx = destination.indexOf("?");
  const params = new URLSearchParams(
    qIdx < 0 ? "" : destination.slice(qIdx + 1),
  );
  if (
    isPaidProvisioningReturn(destination) ||
    params.get("new_assistant") === "1"
  ) {
    return false;
  }
  let path = qIdx < 0 ? destination : destination.slice(0, qIdx);
  if (
    destination.startsWith("http://") ||
    destination.startsWith("https://") ||
    destination.startsWith("//")
  ) {
    try {
      path = new URL(destination, "http://placeholder.invalid").pathname;
    } catch {
      return false;
    }
  }
  return (
    path === routes.onboarding.privacy || path === routes.onboarding.research
  );
}
