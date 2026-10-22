import { RouteErrorBoundary } from "@app/components/route-error-boundary";
import { RootHydrateFallback } from "@app/components/root-hydrate-fallback";

import { ReviewTermsScreen } from "./review-terms-screen";

/**
 * The shell's consent route subtree: the re-review surface renders OUTSIDE
 * the assistant — per the unbundling ruling, a stale-consent user is gated
 * here (in the shell) before any assistant mounts. The screen carries
 * `returnTo` so accepting returns the user to where they were headed.
 */
export const consentRoute = {
  path: "/account/consent",
  ErrorBoundary: RouteErrorBoundary,
  HydrateFallback: RootHydrateFallback,
  children: [
    {
      path: "review-terms",
      lazy: {
        Component: () =>
          import("./review-terms-screen").then((m) => m.ReviewTermsScreen),
      },
    },
  ],
};
