/**
 * The single-origin plan: a served bundle reaches everything through its
 * own origin — the cloud platform serves it at the platform origin, the
 * local app server at its loopback one. No injected or seeded override:
 * the origin IS the answer.
 */

/**
 * The cloud's account billing page — subscription and credit management live
 * there now (the web app retired its billing surfaces).
 */
export function cloudAccountBillingUrl(): string {
  return `${window.location.origin}/account/billing`;
}
