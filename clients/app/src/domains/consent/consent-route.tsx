import { RouteErrorBoundary } from "@app/components/route-error-boundary";
import { RootHydrateFallback } from "@app/components/root-hydrate-fallback";

/**
 * The shell's consent route: first consent and stale-version re-reviews both
 * render OUTSIDE the assistant — per the unbundling ruling, consent takes
 * place at the app shell before any assistant mounts. The screen carries
 * `returnTo` so accepting returns the user to where they were headed.
 */
export const consentRoute = {
  path: "/account/consent",
  ErrorBoundary: RouteErrorBoundary,
  HydrateFallback: RootHydrateFallback,
  lazy: {
    Component: () =>
      import("./review-terms-screen").then((m) => m.ReviewTermsScreen),
  },
};
