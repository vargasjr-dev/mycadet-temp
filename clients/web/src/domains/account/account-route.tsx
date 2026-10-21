import { Navigate } from "react-router";

import { RouteErrorBoundary } from "@/components/route-error-boundary";
import { RootHydrateFallback } from "@/components/root-hydrate-fallback";
import { authMiddleware } from "@/lib/auth/auth-middleware";

import { AccountLayout } from "@/domains/account/account-layout";

/**
 * One-release landing for the account auth pages this bundle no longer
 * owns. Cloud login/signup/OAuth moved off web — the cloud's own account
 * pages are that surface now (the billing tab's hand-off in #451 is the
 * pattern), and the unauthenticated in-SPA front door is the remote-web
 * pairing page. Everything that still navigates to the old paths
 * (bookmarks, the resolver's `requireAuth` bounce, the 401 interceptor's
 * re-entry, `handle-logout`) lands here until those exits are rewired off
 * `/account` entirely.
 */
function RemovedAuthPage() {
  return <Navigate to="/assistant/pair" replace />;
}

/**
 * The /account route subtree, post-nuke. The auth pages this bundle used to
 * own are deleted — their maintained ports live in the app bundle — and the
 * old paths redirect to the pairing page for one release. What survives:
 *
 *   - the assistant chooser (load-bearing: pairing-page hub link, deep
 *     links, guardian-repair, root-layout's `noAutoSkip`),
 *   - password reset (still the target of the reset-email links),
 *   - the OAuth popup relay (`oauth/popup-complete`) — NOT login
 *     machinery: it's the completion page the managed integration-connect
 *     flows (settings tiles, google-calendar) point their popups at.
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
        // Password reset + the provider tier render in the MAIN window.
        // AccountLayout sizes them compact (440×630), matching onboarding.
        // The provider pages stay because the surviving auth-logic tier
        // (login-flow, native-auth) still drives the provider callback —
        // they die with the auth store, not here.
        {
          Component: AccountLayout,
          children: [
            {
              path: "password/reset",
              lazy: {
                Component: () =>
                  import("@/domains/account/pages/password-reset-page").then(
                    (m) => m.PasswordResetPage,
                  ),
              },
            },
            {
              path: "password/reset/key/:key",
              lazy: {
                Component: () =>
                  import("@/domains/account/pages/password-reset-page").then(
                    (m) => m.PasswordResetPage,
                  ),
              },
            },
            {
              path: "provider/callback",
              lazy: {
                Component: () =>
                  import("@/domains/account/pages/provider-callback-page").then(
                    (m) => m.ProviderCallbackPage,
                  ),
              },
            },
            {
              path: "provider/signup",
              lazy: {
                Component: () =>
                  import("@/domains/account/pages/provider-signup-page").then(
                    (m) => m.ProviderSignupPage,
                  ),
              },
            },
          ],
        },
        // The nuked auth pages. Redirects, not 404s: the in-SPA exits
        // (requireAuth, the 401 handler, handle-logout) still navigate to
        // `/account/login` until their rewiring lands.
        { index: true, Component: RemovedAuthPage },
        { path: "login", Component: RemovedAuthPage },
        { path: "signup", Component: RemovedAuthPage },
        { path: "oauth/complete", Component: RemovedAuthPage },
        { path: "oauth/desktop-complete", Component: RemovedAuthPage },
        { path: "cloud-callback", Component: RemovedAuthPage },
        // OAuth completion relay — rendered inside the OAuth popup child
        // window (or the native SFSafariViewController), NOT the main
        // window — so it's deliberately OUTSIDE AccountLayout and never
        // mounts the sizing hook. The resize IPC targets the module-scoped
        // main window, so sizing from a popup would shrink the wrong
        // window. See `use-onboarding-window-size`.
        {
          path: "oauth/popup-complete",
          lazy: {
            Component: () =>
              import("@/domains/account/pages/oauth-popup-complete-page").then(
                (m) => m.OAuthPopupCompletePage,
              ),
          },
        },
        // Assistant selection: which assistant this device talks to. Was
        // /assistant/select-assistant; account-level flows are shell
        // territory, so it lives under /account now.
        {
          path: "select-assistant",
          middleware: [authMiddleware],
          lazy: {
            Component: () =>
              import("@/domains/onboarding/pages/select-assistant-screen").then(
                (m) => m.SelectAssistantScreen,
              ),
          },
        },
      ],
    },
  ],
};
