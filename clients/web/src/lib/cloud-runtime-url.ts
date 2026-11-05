/**
 * The single-origin plan: a served bundle reaches everything through its
 * own origin — the cloud platform serves it at the platform origin, the
 * local app server at its loopback one. No injected or seeded override:
 * the origin IS the answer.
 */
export function getCloudRuntimeUrl(): string {
  if (typeof window === "undefined") {
    // SSR imports this module for the billing link builders; the browser
    // is the only real caller.
    return "";
  }
  return window.location.origin;
}

/**
 * The cloud's account billing page — subscription and credit management live
 * there now (the web app retired its billing surfaces).
 */
export function cloudAccountBillingUrl(): string {
  return `${getCloudRuntimeUrl()}/account/billing`;
}
