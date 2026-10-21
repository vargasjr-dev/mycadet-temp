import { RouteErrorBoundary } from "@/components/route-error-boundary";
import { RootHydrateFallback } from "@/components/root-hydrate-fallback";
import { authMiddleware } from "@/lib/auth/auth-middleware";

import { AccountLayout } from "@/domains/account/account-layout";

/**
 * The /account route subtree. The auth pages this bundle used to own are
 * deleted — their maintained ports live in the app bundle — and their old
 * paths fall through to the NotFound splat (all surfaces are committing to
 * the app shell bundle; nothing redirects them). What survives:
 *
 *   - the assistant chooser (load-bearing: pairing-page hub link, deep
 *     links, guardian-repair, root-layout's `noAutoSkip`),
 *   - the provider tier (the auth-logic tier — login-flow, native-auth —
 *     still drives the provider callback; it dies with the auth store),
 */
export const accountRoute = {
  // Pathless: the surviving children carry absolute paths, so a visit to
  // bare `/account` falls through to the NotFound splat like the rest of
  // the nuked auth paths.
  ErrorBoundary: RouteErrorBoundary,
  HydrateFallback: RootHydrateFallback,
  children: [
    // Pathless wrapper so lazy-chunk failures render the chunk-fail
    // variant of `RouteErrorBoundary` (inline copy + Reload button)
    // rather than the full-page variant inherited from the top.
    {
      ErrorBoundary: RouteErrorBoundary,
      children: [
        // The provider tier renders in the MAIN window; AccountLayout sizes
        // it compact (440×630), matching onboarding. It stays because the
        // auth-logic tier (login-flow, native-auth) still drives the
        // provider callback — it dies with the auth store, not here.
        {
          Component: AccountLayout,
          children: [
            {
              path: "/account/provider/callback",
              lazy: {
                Component: () =>
                  import("@/domains/account/pages/provider-callback-page").then(
                    (m) => m.ProviderCallbackPage,
                  ),
              },
            },
            {
              path: "/account/provider/signup",
              lazy: {
                Component: () =>
                  import("@/domains/account/pages/provider-signup-page").then(
                    (m) => m.ProviderSignupPage,
                  ),
              },
            },
          ],
        },
        // The OAuth completion relay — rendered inside the OAuth popup child
        // window (or the native SFSafariViewController), NOT the main
        // window — so it's deliberately OUTSIDE AccountLayout and never
        // mounts the sizing hook. The resize IPC targets the module-scoped
        // main window, so sizing from a popup would shrink the wrong
        // window. See `use-onboarding-window-size`.
        {
        },
        // Assistant selection: which assistant this device talks to. Was
        // /assistant/select-assistant; account-level flows are shell
        // territory, so it lives under /account now.
        {
          path: "/account/select-assistant",
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
