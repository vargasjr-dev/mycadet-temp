import { Outlet } from "react-router";

import { useOnboardingWindowSize } from "@/hooks/use-onboarding-window-size";

/**
 * Layout for the `/account/*` auth screens that render in the MAIN window —
 * post-nuke, the provider tier only (the provider callback + its signup
 * completion, driven by the auth-logic tier until the auth store dies).
 * These live outside `RootLayout`, so this is where the compact-window
 * sizing hook is mounted for them: they use the same small (440×630) window
 * as onboarding.
 *
 * Renders no chrome of its own.
 */
export function AccountLayout() {
  useOnboardingWindowSize();
  return <Outlet />;
}
