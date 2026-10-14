import { CHECKOUT_LANDING_PATHS } from "@app/domains/account/session-destination-paths";

/** A purchase return requires a cloud session even on the otherwise-local usage page. */
export function isPostCheckoutReturn(destination: string): boolean {
  const qIdx = destination.indexOf("?");
  if (qIdx < 0) return false;
  const path = destination.slice(0, qIdx).split("#")[0] ?? "";
  return (
    CHECKOUT_LANDING_PATHS.has(path) &&
    new URLSearchParams(destination.slice(qIdx + 1)).has("session_id")
  );
}
