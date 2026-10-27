import { sanitizeReturnTo } from "@/utils/return-to";
import {
  isNewAssistantFunnel,
  onboardingDestinationAfterConsent,
} from "@/lib/navigation/onboarding-destination";
import { routes } from "@/utils/routes";
import { buildNavigationState, type NavigationState } from "./build-state";

// ---------------------------------------------------------------------------
// Query — what the caller wants to know
// ---------------------------------------------------------------------------

export type NavigationQuery =
  | { kind: "route-guard"; pathname: string }
  | {
      kind: "post-auth";
      authIntent: "login" | "signup";
      returnTo: string | null;
      fallback: string;
    }
  | { kind: "post-retire" };

// ---------------------------------------------------------------------------
// Decision — what the caller should do
// ---------------------------------------------------------------------------

export type NavigationDecision =
  | { action: "allow" }
  | { action: "redirect"; to: string };

// ---------------------------------------------------------------------------
// Shared predicates & helpers
// ---------------------------------------------------------------------------

const ONBOARDING_PREFIX = `${routes.assistant}/onboarding`;

function isOnboardingPath(pathname: string): boolean {
  return (
    pathname.startsWith(`${ONBOARDING_PREFIX}/`) ||
    pathname === ONBOARDING_PREFIX
  );
}

function extractPathname(destination: string): string {
  if (
    destination.startsWith("http://") ||
    destination.startsWith("https://") ||
    destination.startsWith("//")
  ) {
    try {
      return new URL(destination, "http://placeholder.invalid").pathname;
    } catch {
      return destination;
    }
  }
  return destination;
}

// ---------------------------------------------------------------------------
// Core resolver
// ---------------------------------------------------------------------------

export function resolveNavigation(
  query: NavigationQuery,
): NavigationDecision {
  const state = buildNavigationState();
  switch (query.kind) {
    case "route-guard":
      return resolveRouteGuard(state, query.pathname);
    case "post-auth":
      return resolvePostAuth(
        state,
        query.authIntent,
        query.returnTo,
        query.fallback,
      );
    case "post-retire":
      return resolvePostRetire(state);
  }
}

// ---------------------------------------------------------------------------
// Route guard — pipeline of steps
// ---------------------------------------------------------------------------
//
// Each step returns a NavigationDecision to short-circuit, or null to
// pass through to the next step. The pipeline terminates with "allow".
//
// Conceptual layers:
//   1. Gateway boundary   — a remote gateway's device credential or a live
//                          gateway session admits; otherwise pair
//   2. Setup exemptions   — onboarding paths are always reachable
//   3. Assistant required — the hosting choice (the serving shell never
//                          loads this bundle for a logged-out visitor, so
//                          there is no logged-out case to route)

type RouteGuardStep = (
  state: NavigationState,
  path: string,
  pathnameWithSearch: string,
) => NavigationDecision | null;

const ROUTE_GUARD_PIPELINE: RouteGuardStep[] = [
  allowSetupRoutes,
  requireAssistant,
];

function resolveRouteGuard(
  state: NavigationState,
  pathnameWithSearch: string,
): NavigationDecision {
  const qIdx = pathnameWithSearch.indexOf("?");
  const path =
    qIdx >= 0 ? pathnameWithSearch.slice(0, qIdx) : pathnameWithSearch;

  for (const step of ROUTE_GUARD_PIPELINE) {
    const decision = step(state, path, pathnameWithSearch);
    if (decision) {
      return decision;
    }
  }
  return { action: "allow" };
}

function allowSetupRoutes(
  _state: NavigationState,
  path: string,
  _pathnameWithSearch: string,
): NavigationDecision | null {
  // The funnel entries classify by set membership, not the web prefix below —
  // hatching's app-owned path never matches it.
  if (!isOnboardingPath(path) && !PROVISIONING_FUNNEL_PATHS.has(path)) {
    return null;
  }

  return { action: "allow" };
}

// These entries own provisioning; consent is enforced by the app shell.
const PROVISIONING_FUNNEL_PATHS: ReadonlySet<string> = new Set([
  routes.onboarding.hatching,
  routes.onboarding.research,
]);

function requireAssistant(state: NavigationState): NavigationDecision | null {
  if (state.hasAssistants) {
    return null;
  }

  if (state.isLocalClient) {
    // The hosting screen settles the account question itself (the cloud
    // card locks behind a login hand-off when there is no session).
    return { action: "redirect", to: routes.onboarding.hosting };
  }

  // The served store is never cold in production — the serving shell owns
  // loaded-ness before this bundle loads (#573), and the app's own boot
  // effect maintains the roster thereafter. An empty roster here means a
  // served account with nothing to resolve: funnel to onboarding. Waiting
  // here would loop — the hydration flag this used to wait on has no
  // writer off the local arm.
  return { action: "redirect", to: routes.onboarding.hatching };
}

// ---------------------------------------------------------------------------
// post-auth
// ---------------------------------------------------------------------------

// The bring-your-agent import funnel (marketing /import page) replaces
// onboarding entirely: the imported agent's data IS the setup. A signup that
// started there must land back on /import; the funnel offers an explicit
// "skip import" path into onboarding instead. Other signup entry points
// (including plugin-attributed signups) keep the onboarding redirect.
const IMPORT_FUNNEL_PATH = "/import";

function isImportFunnelDestination(destination: string): boolean {
  return (
    destination === IMPORT_FUNNEL_PATH ||
    destination.startsWith(`${IMPORT_FUNNEL_PATH}?`) ||
    destination.startsWith(`${IMPORT_FUNNEL_PATH}/`)
  );
}

/** The query of a `pathname?search` string the guard was handed. */
function searchParamsOf(pathnameWithSearch: string): URLSearchParams {
  const qIdx = pathnameWithSearch.indexOf("?");
  return new URLSearchParams(
    qIdx >= 0 ? pathnameWithSearch.slice(qIdx + 1) : "",
  );
}

function isOnboardingResearchPath(destination: string): boolean {
  const path = extractPathname(destination);
  const qIdx = path.indexOf("?");
  const pathname = qIdx < 0 ? path : path.slice(0, qIdx);
  return pathname === routes.onboarding.research;
}

function resolvePostAuth(
  state: NavigationState,
  authIntent: "login" | "signup",
  returnTo: string | null,
  fallback: string,
): NavigationDecision {
  const destination = sanitizeReturnTo(returnTo, fallback);
  // The import funnel replaces onboarding: a signup that started on /import
  // lands back there instead of the consent screen.
  if (authIntent === "signup" && isImportFunnelDestination(destination)) {
    return { action: "redirect", to: destination };
  }

  // A returning user skips first-run privacy and research. Two funnel
  // destinations are still real work rather than a re-run, so they survive: a
  // fresh-assistant funnel entry, and a walk that is provisioning a new
  // assistant.
  if (state.userHasOnboardedAssistant) {
    const isRealWork = isNewAssistantFunnel(searchParamsOf(destination));
    const skipTarget =
      !isRealWork && isOnboardingResearchPath(destination)
        ? fallback
        : destination;
    return { action: "redirect", to: skipTarget };
  }

  if (authIntent !== "signup") {
    return { action: "redirect", to: destination };
  }
  // A first-run signup consents at the shell's screen (the app bundle), then
  // rides returnTo into the same post-consent destination the privacy screen
  // used to hand off.
  const signupNext = onboardingDestinationAfterConsent({
    isLocalHatch: false,
  });
  return {
    action: "redirect",
    to: `/account/consent?returnTo=${encodeURIComponent(signupNext)}`,
  };
}

// ---------------------------------------------------------------------------
// post-retire
// ---------------------------------------------------------------------------

function resolvePostRetire(state: NavigationState): NavigationDecision {
  if (state.hasAssistants) {
    return {
      action: "redirect",
      to: routes.assistant,
    };
  }
  if (!state.isLocalClient) {
    return { action: "redirect", to: routes.onboarding.research };
  }
  return { action: "redirect", to: routes.onboarding.hosting };
}
