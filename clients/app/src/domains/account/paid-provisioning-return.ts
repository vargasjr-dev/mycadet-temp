import { sanitizeReturnTo } from "@app/utils/return-to";
import { PAID_PROVISIONING_PATHS } from "@app/domains/account/session-destination-paths";

/** Recognize paid provisioning returns; ordinary cloud hosting does not imply a purchase. */
export function isPaidProvisioningReturn(value: string): boolean {
  const destination = sanitizeReturnTo(value, "");
  if (!destination.startsWith("/")) return false;
  const qIdx = destination.indexOf("?");
  if (qIdx < 0 || !PAID_PROVISIONING_PATHS.has(destination.slice(0, qIdx)))
    return false;
  return (
    new URLSearchParams(destination.slice(qIdx + 1)).get("post_checkout") ===
    "1"
  );
}
