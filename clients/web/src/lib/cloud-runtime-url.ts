/**
 * The cloud's account billing page — subscription and credit management live
 * there now (the web app retired its billing surfaces).
 */
export function cloudAccountBillingUrl(): string {
  return `${window.location.origin}/account/billing`;
}
