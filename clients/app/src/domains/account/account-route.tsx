import { Navigate, useSearchParams } from "react-router";

import { RouteErrorBoundary } from "@app/components/route-error-boundary";
import { RootHydrateFallback } from "@app/components/root-hydrate-fallback";
import { routes } from "@app/utils/routes";

import { AccountLayout } from "@app/domains/account/account-layout";

/**
 * Redirects legacy `/account/oauth/desktop-complete` to the canonical
 * `/account/oauth/complete`, preserving all query parameters. Older macOS
 * and iOS Capacitor builds have the old path baked in.
 */
function OAuthDesktopCompleteRedirect() {
  const [searchParams] = useSearchParams();
  const qs = searchParams.toString();
  return (
    <Navigate
      to={`${routes.account.oauth.complete}${qs ? `?${qs}` : ""}`}
      replace
    />
  );
}

/**
 * The whole /account route subtree: standalone auth pages, no app chrome.
 * Lazy-loaded — only needed for unauthenticated flows.
 *
 * The desktop shell composes this into its root route tree.
 */
export const accountRoute = {
  path: "/account",
  ErrorBoundary: RouteErrorBoundary,
  HydrateFallback: RootHydrateFallback,
  children: [
    // Pathless wrapper so lazy-chunk failures render the chunk-fail
    // variant of `RouteErrorBoundary` (inline copy + Reload button)
    // rather than the full-page variant inherited from the top.
    {
      ErrorBoundary: RouteErrorBoundary,
      children: [
        // Auth screens that render in the MAIN window. AccountLayout sizes
        // it compact (440×630) for these, matching onboarding.
        {
          Component: AccountLayout,
          children: [
            {
              index: true,
              lazy: {
                Component: () =>
                  import("@app/domains/account/pages/account-page").then(
                    (m) => m.AccountPage,
                  ),
              },
            },
            {
              path: "login",
              lazy: {
                Component: () =>
                  import("@app/domains/account/pages/login-page").then(
                    (m) => m.LoginPage,
                  ),
              },
            },
            {
              path: "signup",
              lazy: {
                Component: () =>
                  import("@app/domains/account/pages/signup-page").then(
                    (m) => m.SignupPage,
                  ),
              },
            },
            {
              // The pre-hatch onboarding front door (bucket D): ported from
              // web's `/assistant/welcome` + `/assistant/onboarding/start`,
              // which now bounce here cross-bundle. The remaining funnel
              // steps (hatching, research) stay web-side and are reached
              // through the AssistantPage iframe mount.
              path: "onboarding/welcome",
              lazy: {
                Component: () =>
                  import("@app/domains/onboarding/pages/welcome-screen").then(
                    (m) => m.WelcomeScreen,
                  ),
              },
            },
            {
              path: "onboarding/start",
              lazy: {
                Component: () =>
                  import("@app/domains/onboarding/pages/start-screen").then(
                    (m) => m.StartScreen,
                  ),
              },
            },
            {
              path: "onboarding/hosting",
              lazy: {
                Component: () =>
                  import("@app/domains/onboarding/pages/hosting-screen").then(
                    (m) => m.HostingScreen,
                  ),
              },
            },
            {
              path: "onboarding/api-key",
              lazy: {
                Component: () =>
                  import("@app/domains/onboarding/pages/api-key-screen").then(
                    (m) => m.ApiKeyScreen,
                  ),
              },
            },
            {
              path: "provider/callback",
              lazy: {
                Component: () =>
                  import("@app/domains/account/pages/provider-callback-page").then(
                    (m) => m.ProviderCallbackPage,
                  ),
              },
            },
            {
              path: "provider/signup",
              lazy: {
                Component: () =>
                  import("@app/domains/account/pages/provider-signup-page").then(
                    (m) => m.ProviderSignupPage,
                  ),
              },
            },
            {
              path: "password/reset",
              lazy: {
                Component: () =>
                  import("@app/domains/account/pages/password-reset-page").then(
                    (m) => m.PasswordResetPage,
                  ),
              },
            },
            {
              path: "password/reset/key/:key",
              lazy: {
                Component: () =>
                  import("@app/domains/account/pages/password-reset-page").then(
                    (m) => m.PasswordResetPage,
                  ),
              },
            },
          ],
        },
        // OAuth completion / loopback machinery. These render inside the
        // OAuth popup child window (or are transient redirects), NOT the
        // main window — so they're deliberately OUTSIDE AccountLayout and
        // never mount the sizing hook. The resize IPC targets the
        // module-scoped main window, so sizing from a popup would shrink
        // the wrong window. See `use-onboarding-window-size`.
        {
          path: "oauth/popup-complete",
          lazy: {
            Component: () =>
              import("@app/domains/account/pages/oauth-popup-complete-page").then(
                (m) => m.OAuthPopupCompletePage,
              ),
          },
        },
        {
          path: "oauth/complete",
          lazy: {
            Component: () =>
              import("@app/domains/account/pages/oauth-complete-page").then(
                (m) => m.OAuthCompletePage,
              ),
          },
        },
        {
          path: "oauth/desktop-complete",
          Component: OAuthDesktopCompleteRedirect,
        },
        {
          path: "cloud-callback",
          lazy: {
            Component: () =>
              import("@app/domains/account/pages/cloud-loopback-page").then(
                (m) => m.CloudLoopbackPage,
              ),
          },
        },
        {
          path: "select-assistant",
          lazy: {
            Component: () =>
              import("@app/domains/account/pages/select-assistant-screen").then(
                (m) => m.SelectAssistantScreen,
              ),
          },
        },
      ],
    },
  ],
};
