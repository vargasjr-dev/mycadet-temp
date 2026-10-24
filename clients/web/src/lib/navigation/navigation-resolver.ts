import type { CloudSessionStatus } from "@/stores/session-status";
import { sanitizeReturnTo } from "@/utils/return-to";
import {
  canSkipOnboardingResearch,
  isNewAssistantFunnel,
  onboardingDestinationAfterConsent,
  withSkipResearch,
} from "@/domains/onboarding/onboarding-destination";
import { routes } from "@/utils/routes";

// ---------------------------------------------------------------------------
// State — every variable that can influence a routing decision
// ---------------------------------------------------------------------------

export interface NavigationState {
  isLocalClient: boolean;
  isRemoteGateway: boolean;
  remoteGatewayPublicPathPrefix: string;
  isGatewaySessionLive: boolean;
  hasAssistants: boolean;
  sessionSettled: boolean;
  isAuthenticated: boolean;
  cloudSession: CloudSessionStatus;
  tosAccepted: boolean;
  privacyConsent: boolean;
  /**
   * Whether the consent flags above reflect a completed session sync (or an
   * explicit acceptance). They boot `false`, so acting on them before
   * hydration would misread an established user as un-onboarded.
   */
  consentHydrated: boolean;
  /**
   * Whether the cloud has any consent record for this user (a first consent
   * or later). Both acceptance flags above boot `false` and stay `false` for
   * a never-consented user AND for an established user whose accepted
   * versions went stale — this flag is the discriminator between the two,
   * which is what decides a first-consent funnel versus a re-review.
   */
  hasConsentRecord: boolean;

  /**
   * Whether `consentHydrated` above was forced by the auth middleware after its
   * hydration wait timed out. The consent flags then still read their boot
   * `false`, so a gate that treats them as a settled "not consented" would
   * evict a consented user. Absent on every other caller — only the middleware
   * can know its own wait ran out.
   */
  consentHydrationTimedOut?: boolean;
  /** Whether the resolved assistants list reflects at least one authoritative load. */
  assistantsHydrated: boolean;
  /**
   * Whether the user owns ANY assistant past first-run onboarding, i.e. is a
   * returning user. The right question for post-auth and the onboarding
   * intercept, where the assistant they will land in is not yet known.
   */
  userHasOnboardedAssistant: boolean;
  /**
   * Whether the SELECTED assistant is past first-run onboarding. False when
   * nothing is selected. The right question for the privacy funnel, which is
   * always about one assistant.
   */
  selectedAssistantOnboarded: boolean;
}

// ---------------------------------------------------------------------------
// Query — what the caller wants to know
// ---------------------------------------------------------------------------

export type NavigationQuery =
  | { kind: "route-guard"; pathname: string }
  | { kind: "onboarding-intercept"; intendedDestination: string }
  | { kind: "hatch-gate" }
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
  | { action: "redirect"; to: string }
  /**
   * State the decision depends on has not settled yet.
   *
   * `waitFor` names the signal when it is one the caller has to block on
   * beyond the session itself, so a caller that can await it (the auth
   * middleware) awaits exactly that signal instead of guessing from the
   * surrounding state — guessing wrong re-resolves on unchanged state and
   * spins.
   */
  | { action: "wait"; waitFor?: "cloud-session" };

// ---------------------------------------------------------------------------
// Shared predicates & helpers
// ---------------------------------------------------------------------------

function hasCompletedOnboarding(state: NavigationState): boolean {
  return state.tosAccepted && state.privacyConsent;
}

const ONBOARDING_PREFIX = `${routes.assistant}/onboarding`;

function isOnboardingPath(pathname: string): boolean {
  return (
    pathname.startsWith(`${ONBOARDING_PREFIX}/`) ||
    pathname === ONBOARDING_PREFIX
  );
}

// The cloud arm targets the app bundle's consent screen — a cross-bundle
// literal (house pattern): it lives outside web's route table on purpose.
function onboardingEntrypoint(isLocalClient: boolean): string {
  return isLocalClient ? routes.welcome : "/account/consent";
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
  state: NavigationState,
  query: NavigationQuery,
): NavigationDecision {
  switch (query.kind) {
    case "route-guard":
      return resolveRouteGuard(state, query.pathname);
    case "onboarding-intercept":
      return resolveOnboardingIntercept(state, query.intendedDestination);
    case "hatch-gate":
      return resolveHatchGate(state);
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
//   1. Readiness          — is the session ready?
//   2. Bypass             — gateway auth skips everything but a paid return
//   4. Identity           — is the user authenticated?
//   5. Mode boundary      — is this path valid for the user's mode?
//   6. Setup exemptions   — onboarding paths are always reachable
//   7. Assistant required  — user needs at least one assistant
//   8. Consent required   — platform users must accept TOS

type RouteGuardStep = (
  state: NavigationState,
  path: string,
  pathnameWithSearch: string,
) => NavigationDecision | null;

const ROUTE_GUARD_PIPELINE: RouteGuardStep[] = [
  waitForSession,
  requireRemoteGatewayPairing,
  allowGatewayAuth,
  requireAuth,
  allowSetupRoutes,
  requireAssistant,
  requireConsent,
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

function waitForSession(state: NavigationState): NavigationDecision | null {
  return state.sessionSettled ? null : { action: "wait" };
}

/**
 * A gateway session answers for itself, so it skips the rest of the pipeline.
 */
function allowGatewayAuth(state: NavigationState): NavigationDecision | null {
  if (!state.isGatewaySessionLive) {
    return null;
  }
  return { action: "allow" };
}

function stripRemoteGatewayPublicPathPrefix(
  state: NavigationState,
  pathnameWithSearch: string,
): string {
  const prefix = state.remoteGatewayPublicPathPrefix;
  if (!state.isRemoteGateway || !prefix) {
    return pathnameWithSearch;
  }
  if (pathnameWithSearch === prefix) {
    return routes.assistant;
  }
  if (pathnameWithSearch.startsWith(`${prefix}/`)) {
    return pathnameWithSearch.slice(prefix.length);
  }
  return pathnameWithSearch;
}

/**
 * The connection slot's device credential decides, not the auth store: the
 * pairing page's boot settles the store unauthenticated on the public pair
 * route before the approved exchange lands, and the credential the exchange
 * establishes is the same signal `isGatewaySessionLive` reads next.
 */
function requireRemoteGatewayPairing(
  state: NavigationState,
  _path: string,
  pathnameWithSearch: string,
): NavigationDecision | null {
  if (!state.isRemoteGateway || state.isGatewaySessionLive) {
    return null;
  }

  const returnTo = stripRemoteGatewayPublicPathPrefix(
    state,
    pathnameWithSearch,
  );
  return {
    action: "redirect",
    to: `${routes.remotePair}?returnTo=${encodeURIComponent(returnTo)}`,
  };
}

/**
 * The local-mode chooser, decided the same way for an unauthenticated visit
 * (`requireAuth`) and an authenticated one: an empty lockfile has nothing to
 * choose from, so the visit funnels to hosting.
 *
 * Deciding either way is what keeps the local chooser short-circuiting ahead of
 * the assistant and consent gates: it is itself an onboarding surface,
 * reachable before there is a cloud session to gate on.
 */
function requireAuth(
  state: NavigationState,
  path: string,
  pathnameWithSearch: string,
): NavigationDecision | null {
  if (state.isAuthenticated) {
    return null;
  }

  if (state.isLocalClient && isOnboardingPath(path)) {
    return { action: "allow" };
  }
  if (state.isLocalClient && !state.hasAssistants) {
    return { action: "redirect", to: routes.welcome };
  }
  if (state.isLocalClient) {
    return { action: "redirect", to: routes.assistant };
  }
  // No web surface offers cloud login anymore — the unauthenticated bounce
  // lands on the remote-web pairing page, the same front door
  // `requireRemoteGatewayPairing` uses, returnTo preserved so a successful
  // exchange returns the visit to where it was headed.
  return {
    action: "redirect",
    to: `${routes.remotePair}?returnTo=${encodeURIComponent(
      stripRemoteGatewayPublicPathPrefix(state, pathnameWithSearch),
    )}`,
  };
}

function allowSetupRoutes(
  state: NavigationState,
  path: string,
  _pathnameWithSearch: string,
): NavigationDecision | null {
  if (!isOnboardingPath(path)) {
    return null;
  }

  return enforceFunnelConsent(state, path);
}

/**
 * Consent for the two provisioning funnel entries, which `requireConsent` never
 * reaches — every onboarding path is allowed before it runs. It decides every
 * onboarding path outright: anything that is not a funnel entry is plainly
 * allowed.
 *
 * The hatching entry keeps exactly the gate it has always had — reached from
 * in-app navigation, it decides on the flags in hand and leaves stale-toggle
 * review to the screen's own `hatch-gate`. The research entry also waits for
 * the flags to hydrate on a cold deep link.
 */
const PROVISIONING_FUNNEL_PATHS: ReadonlySet<string> = new Set([
  routes.onboarding.hatching,
  routes.onboarding.research,
]);

function enforceFunnelConsent(
  state: NavigationState,
  path: string,
): NavigationDecision {
  if (!PROVISIONING_FUNNEL_PATHS.has(path)) {
    return { action: "allow" };
  }

  if (path === routes.onboarding.research) {
    // The consent flags are still at their boot defaults on a cold deep link,
    // and bouncing on them would send an already-consented user to privacy.
    // Local mode is excluded for the same reason as in `requireConsent`: its
    // consent either hydrates synchronously during session init or never does,
    // so waiting would hang navigation.
    if (!state.isLocalClient && !state.consentHydrated) {
      return { action: "wait" };
    }
    // A hydration that never landed leaves those boot defaults behind a forced
    // `consentHydrated`, so the gates below would read a consented user as
    // un-onboarded and restart their funnel. Fail open to the entry's
    // unconditional contract instead; a hydrated read still gates.
    if (state.consentHydrationTimedOut) {
      return { action: "allow" };
    }
  }

  // First consent only: a user with no consent record at all. A
  // record-holder whose acceptance went stale is handled by the hatching
  // screen's own hatch-gate. Gated on the cloud session — consent is a
  // cloud-account concern, so a local-only client (no session to consent
  // against) proceeds ungated.
  if (
    state.cloudSession === "present" &&
    !state.hasConsentRecord &&
    !hasCompletedOnboarding(state)
  ) {
    return { action: "redirect", to: "/account/consent" };
  }

  return { action: "allow" };
}

function requireAssistant(
  state: NavigationState,
  path: string,
  pathnameWithSearch: string,
): NavigationDecision | null {
  if (state.hasAssistants) {
    return null;
  }

  if (state.isLocalClient) {
    if (state.cloudSession === "unknown") {
      return { action: "wait", waitFor: "cloud-session" };
    }
    if (state.cloudSession === "present") {
      return { action: "redirect", to: routes.onboarding.hosting };
    }
    return { action: "redirect", to: routes.welcome };
  }

  // Platform boot populates the assistants list and the consent flags
  // asynchronously; both boot empty/false. Deciding before they hydrate would
  // read an established user as brand-new and funnel them into onboarding.
  // (Local mode is excluded above — its list is lockfile-driven.)
  if (!state.assistantsHydrated || !state.consentHydrated) {
    return { action: "wait" };
  }

  if (!hasCompletedOnboarding(state)) {
    // First consent and a stale acceptance both settle at the shell's consent
    // screen (the app bundle), returnTo preserved for the ride back — the
    // screen frames itself first-consent vs re-review off the record.
    const returnTo = encodeURIComponent(pathnameWithSearch);
    return {
      action: "redirect",
      to: `/account/consent?returnTo=${returnTo}`,
    };
  }
  // A consented user with no assistant goes to the standard hatching screen.
  return { action: "redirect", to: routes.onboarding.hatching };
}

function requireConsent(
  state: NavigationState,
  _path: string,
  pathnameWithSearch: string,
): NavigationDecision | null {
  // Consent is a cloud-account concern: only enforce it when there is a
  // live platform session to consent against. A disabled platform or an
  // absent/unknown session has no server consent record to gate on. Note this
  // is NOT gated on isLocalClient — a local-mode client with a cloud session
  // still re-reviews stale terms.
  if (state.cloudSession !== "present" || hasCompletedOnboarding(state)) {
    return null;
  }

  // The flags boot false and hydrate asynchronously — a redirect decided
  // before hydration would bounce a fully consented user to review-terms.
  // Local mode decides immediately: its cloud-session paths that enforce
  // consent hydrate synchronously during session init, and the gateway-probe
  // path never hydrates, so waiting there would hang navigation.
  if (!state.consentHydrated && !state.isLocalClient) {
    return { action: "wait" };
  }

  const returnTo = encodeURIComponent(pathnameWithSearch);
  return {
    action: "redirect",
    to: `/account/consent?returnTo=${returnTo}`,
  };
}

// ---------------------------------------------------------------------------
// onboarding-intercept
// ---------------------------------------------------------------------------

function resolveOnboardingIntercept(
  state: NavigationState,
  intendedDestination: string,
): NavigationDecision {
  if (state.isLocalClient && state.hasAssistants) {
    return { action: "allow" };
  }
  if (
    hasCompletedOnboarding(state) ||
    state.hasConsentRecord ||
    state.userHasOnboardedAssistant
  ) {
    return { action: "allow" };
  }

  const path = extractPathname(intendedDestination);
  if (!path.startsWith(routes.assistant)) {
    return { action: "allow" };
  }
  if (path.startsWith(`${routes.assistant}/onboarding`)) {
    return { action: "allow" };
  }

  return {
    action: "redirect",
    to: onboardingEntrypoint(state.isLocalClient),
  };
}

// ---------------------------------------------------------------------------
// hatch-gate
// ---------------------------------------------------------------------------

function resolveHatchGate(state: NavigationState): NavigationDecision {
  if (!state.sessionSettled) {
    return { action: "wait" };
  }
  if (!state.isAuthenticated && !state.isLocalClient) {
    return { action: "redirect", to: routes.remotePair };
  }
  if (state.cloudSession === "present" && !hasCompletedOnboarding(state)) {
    // First consent and a stale acceptance both settle at the shell's consent
    // screen. Local-only clients have no session to consent against, so they
    // are not gated here.
    return { action: "redirect", to: "/account/consent" };
  }
  return { action: "allow" };
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
  const skipResearch = canSkipOnboardingResearch();
  const postConsentDestination = onboardingDestinationAfterConsent({
    isLocalHatch: false,
    skipResearch,
  });
  const signupNext = skipResearch
    ? withSkipResearch(postConsentDestination)
    : postConsentDestination;
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
  if (state.cloudSession === "present") {
    return { action: "redirect", to: routes.onboarding.hosting };
  }
  return { action: "redirect", to: routes.welcome };
}
