import { routes } from "@/utils/routes";
import { isLocalClient } from "@/lib/local-mode";

/**
 * Where a logged-out user lands. The onboarding surfaces live in the app
 * bundle — web only picks the URL (handle-logout's landing page).
 */
export function getOnboardingEntrypoint(): string {
  return isLocalClient() ? routes.welcome : routes.onboarding.research;
}
