import { routes } from "@app/utils/routes";

/** URL contract consumed by account entry; assistant routing stays in web. */
export const PLATFORM_ONLY_PATHS: readonly string[] = [
  "/assistant/checkout",
  "/assistant/plans",
  "/assistant/settings/billing",
  routes.account.root,
];
export const CHECKOUT_LANDING_PATHS: ReadonlySet<string> = new Set([
  "/assistant/settings/billing",
  "/assistant/settings/usage",
]);
export const PAID_PROVISIONING_PATHS: ReadonlySet<string> = new Set([
  "/assistant/onboarding/hatching",
  "/assistant/onboarding/research",
]);
