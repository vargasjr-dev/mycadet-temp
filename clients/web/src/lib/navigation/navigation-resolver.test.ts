import { beforeEach, describe, test, expect } from "bun:test";

import { NEW_ASSISTANT_PARAM } from "@/domains/onboarding/onboarding-destination";

import {
  resolveNavigation,
  resolveLoginReturnTo,
  type NavigationState,
  type NavigationDecision,
} from "./navigation-resolver";

const base: NavigationState = {
  isLocalClient: false,
  isRemoteGateway: false,
  remoteGatewayPublicPathPrefix: "",
  isGatewaySessionLive: false,
  hasAssistants: true,
  sessionSettled: true,
  isAuthenticated: true,
  cloudSession: "present",
  tosAccepted: true,
  privacyConsent: true,
  // A settled consent record by default — the base models a user who consented
  // at some point, so acceptance-flag overrides below read as STALE versions
  // (a re-review), not as a never-consented user. The first-consent cases
  // override this to false explicitly.
  hasConsentRecord: true,
  // Hydrated by default so the cases below describe settled-state behavior;
  // the hydration-gating cases override these explicitly.
  consentHydrated: true,
  assistantsHydrated: true,
  userHasOnboardedAssistant: false,
  selectedAssistantOnboarded: false,
};

function s(overrides: Partial<NavigationState>): NavigationState {
  return { ...base, ...overrides };
}

/** The path a redirect decision targets, ignoring its query. */
function redirectPath(decision: NavigationDecision): string | null {
  if (decision.action !== "redirect") {
    return null;
  }
  const qIdx = decision.to.indexOf("?");
  return qIdx < 0 ? decision.to : decision.to.slice(0, qIdx);
}

// The two provisioning funnel entries: managed cloud hatches (hosting
// forced to cadet-cloud so a local-mode client provisions on the cloud).
const RESEARCH_FUNNEL_URL =
  "/assistant/onboarding/research?hosting=cadet-cloud";
const HATCHING_FUNNEL_URL =
  "/assistant/onboarding/hatching?hosting=cadet-cloud";

// A signup consents at the shell's screen carrying the post-consent funnel
// destination as the returnTo (non-production builds skip research).
const consentCarry = () =>
  `/account/consent?returnTo=${encodeURIComponent(
    "/assistant/onboarding/hatching?skip_research=1",
  )}`;

const ALLOW: NavigationDecision = { action: "allow" };
const WAIT: NavigationDecision = { action: "wait" };
// The auth middleware awaits the probe only for a wait that names it, so the
// tag is part of the contract, not a label.
const WAIT_FOR_PLATFORM_SESSION: NavigationDecision = {
  action: "wait",
  waitFor: "cloud-session",
};

describe("resolveNavigation", () => {
  // -----------------------------------------------------------------------
  // route-guard
  // -----------------------------------------------------------------------
  describe("route-guard", () => {
    const guard = (state: NavigationState, pathname = "/assistant") =>
      resolveNavigation(state, { kind: "route-guard", pathname });

    test("waits when session not settled", () => {
      expect(guard(s({ sessionSettled: false }))).toEqual(WAIT);
    });

    test("allows gateway auth regardless of auth status", () => {
      expect(
        guard(s({ isGatewaySessionLive: true, isAuthenticated: false })),
      ).toEqual(ALLOW);
    });

    // -- unauthenticated --------------------------------------------------

    test("redirects unauthenticated platform user to the pairing page", () => {
      expect(guard(s({ isAuthenticated: false }))).toEqual({
        action: "redirect",
        to: "/assistant/pair?returnTo=%2Fassistant",
      });
    });

    test("preserves query string in returnTo", () => {
      const result = guard(
        s({ isAuthenticated: false }),
        "/assistant/identity?tab=1",
      );
      expect(result).toEqual({
        action: "redirect",
        to: "/assistant/pair?returnTo=%2Fassistant%2Fidentity%3Ftab%3D1",
      });
    });

    test("redirects remote-gateway browsers with no gateway session to pairing", () => {
      const result = guard(
        s({
          isAuthenticated: true,
          isLocalClient: true,
          isRemoteGateway: true,
          hasAssistants: true,
        }),
        "/assistant/conversations/self?tab=latest",
      );

      expect(result).toEqual({
        action: "redirect",
        to: "/assistant/pair?returnTo=%2Fassistant%2Fconversations%2Fself%3Ftab%3Dlatest",
      });
    });

    test("admits a paired-in browser whose store session is still unauthenticated", () => {
      const result = guard(
        s({
          isAuthenticated: false,
          isGatewaySessionLive: true,
          isLocalClient: true,
          isRemoteGateway: true,
          hasAssistants: true,
        }),
        "/assistant/conversations/self?tab=latest",
      );

      expect(result).toEqual(ALLOW);
    });

    test("strips remote-gateway public prefix from pairing returnTo", () => {
      const result = guard(
        s({
          isAuthenticated: false,
          isLocalClient: true,
          isRemoteGateway: true,
          remoteGatewayPublicPathPrefix: "/assistant-123",
          hasAssistants: true,
        }),
        "/assistant-123/assistant/conversations/self?tab=latest",
      );

      expect(result).toEqual({
        action: "redirect",
        to: "/assistant/pair?returnTo=%2Fassistant%2Fconversations%2Fself%3Ftab%3Dlatest",
      });
    });

    // The standalone welcome route moved to the app bundle
    // (/account/onboarding/welcome) — web's route table never sees it, so
    // there is no unauthenticated-allow pin to keep for it here.

    test("redirects unauthenticated local-mode fresh user to welcome", () => {
      expect(
        guard(
          s({
            isAuthenticated: false,
            isLocalClient: true,
            hasAssistants: false,
          }),
        ),
      ).toEqual({ action: "redirect", to: "/account/onboarding/welcome" });
    });

    test("redirects unauthenticated local-mode returning user (has assistants) to the assistant", () => {
      expect(
        guard(
          s({
            isAuthenticated: false,
            isLocalClient: true,
            hasAssistants: true,
          }),
        ),
      ).toEqual({ action: "redirect", to: "/assistant" });
    });

    // -- authenticated, onboarding routes ---------------------------------

    test("allows authenticated user on onboarding route regardless of assistant count", () => {
      expect(guard(s({}), "/assistant/onboarding/hatching")).toEqual(ALLOW);
      expect(
        guard(s({ hasAssistants: false }), "/assistant/onboarding/hatching"),
      ).toEqual(ALLOW);
    });

    test("keeps research reachable on demand for an onboarded selection", () => {
      expect(
        guard(
          s({ selectedAssistantOnboarded: true }),
          "/assistant/onboarding/research",
        ),
      ).toEqual(ALLOW);
    });

    test("query strings do not break onboarding path matching", () => {
      expect(
        guard(
          s({ hasAssistants: false }),
          "/assistant/onboarding/research?replay=1",
        ),
      ).toEqual(ALLOW);
      expect(
        guard(
          s({ hasAssistants: false, tosAccepted: true, privacyConsent: true }),
          "/assistant/onboarding/hatching?hosting=local",
        ),
      ).toEqual(ALLOW);
    });

    test("allows non-local user on onboarding screens regardless of assistant count", () => {
      expect(
        guard(s({ isLocalClient: false }), "/assistant/onboarding/hatching"),
      ).toEqual(ALLOW);
      expect(
        guard(
          s({ isLocalClient: false, hasAssistants: false }),
          "/assistant/onboarding/hatching",
        ),
      ).toEqual(ALLOW);
    });

    test("redirects a cloud user from hatching to consent when consent missing", () => {
      expect(
        guard(
          s({
            cloudSession: "present",
            tosAccepted: false,
            privacyConsent: false,
            hasConsentRecord: false,
          }),
          "/assistant/onboarding/hatching",
        ),
      ).toEqual({ action: "redirect", to: "/account/consent" });
    });

    test("allows a local-only user on hatching without a consent record", () => {
      // Consent is a cloud-account concern: with no session to consent
      // against, a local-only client is not gated here.
      expect(
        guard(
          s({
            isLocalClient: true,
            cloudSession: "absent",
            tosAccepted: false,
            privacyConsent: false,
            hasConsentRecord: false,
          }),
          "/assistant/onboarding/hatching",
        ),
      ).toEqual(ALLOW);
    });

    test("allows user on hatching when consent present", () => {
      expect(
        guard(
          s({ tosAccepted: true, privacyConsent: true }),
          "/assistant/onboarding/hatching",
        ),
      ).toEqual(ALLOW);
    });

    test("redirects a cloud user from hatching to consent with partial consent", () => {
      expect(
        guard(
          s({
            cloudSession: "present",
            tosAccepted: true,
            privacyConsent: false,
            hasConsentRecord: false,
          }),
          "/assistant/onboarding/hatching",
        ),
      ).toEqual({ action: "redirect", to: "/account/consent" });
    });

    test("redirects a cloud user from hatching without consent when no assistants", () => {
      expect(
        guard(
          s({
            hasAssistants: false,
            cloudSession: "present",
            tosAccepted: false,
            privacyConsent: false,
            hasConsentRecord: false,
          }),
          "/assistant/onboarding/hatching",
        ),
      ).toEqual({ action: "redirect", to: "/account/consent" });
    });

    test("allows hatching without consent in local-only mode", () => {
      expect(
        guard(
          s({
            isLocalClient: true,
            cloudSession: "absent",
            tosAccepted: false,
            privacyConsent: false,
            hasConsentRecord: false,
          }),
          "/assistant/onboarding/hatching",
        ),
      ).toEqual(ALLOW);
    });

    test("allows hatching with consent when no assistants", () => {
      expect(
        guard(
          s({ hasAssistants: false, tosAccepted: true, privacyConsent: true }),
          "/assistant/onboarding/hatching",
        ),
      ).toEqual(ALLOW);
    });

    // -- authenticated, local mode, no assistants -------------------------

    test("waits for platform probe in local mode with no assistants", () => {
      expect(
        guard(
          s({
            isLocalClient: true,
            hasAssistants: false,
            cloudSession: "unknown",
          }),
        ),
      ).toEqual(WAIT_FOR_PLATFORM_SESSION);
    });

    test("redirects to hosting when local mode + platform session present", () => {
      expect(
        guard(
          s({
            isLocalClient: true,
            hasAssistants: false,
            cloudSession: "present",
          }),
        ),
      ).toEqual({ action: "redirect", to: "/account/onboarding/hosting" });
    });

    test("redirects to welcome when local mode + no platform session", () => {
      expect(
        guard(
          s({
            isLocalClient: true,
            hasAssistants: false,
            cloudSession: "absent",
          }),
        ),
      ).toEqual({ action: "redirect", to: "/account/onboarding/welcome" });
    });

    test("allows local mode with assistants", () => {
      expect(guard(s({ isLocalClient: true, hasAssistants: true }))).toEqual(
        ALLOW,
      );
    });

    // -- authenticated, platform mode, not onboarded ----------------------

    test("redirects platform-mode user without consent to consent with returnTo", () => {
      expect(
        guard(
          s({
            isLocalClient: false,
            tosAccepted: false,
            privacyConsent: false,
          }),
        ),
      ).toEqual({
        action: "redirect",
        to: "/account/consent?returnTo=%2Fassistant",
      });
    });

    test("redirects platform-mode user with partial consent to consent with returnTo", () => {
      expect(
        guard(
          s({ isLocalClient: false, tosAccepted: true, privacyConsent: false }),
        ),
      ).toEqual({
        action: "redirect",
        to: "/account/consent?returnTo=%2Fassistant",
      });
    });

    test("redirects platform-mode user without consent and no assistants to consent, not hatching", () => {
      expect(
        guard(
          s({
            isLocalClient: false,
            tosAccepted: false,
            privacyConsent: false,
            hasAssistants: false,
            hasConsentRecord: false,
          }),
        ),
      ).toEqual({
        action: "redirect",
        to: "/account/consent?returnTo=%2Fassistant",
      });
    });

    // -- hydration gating ---------------------------------------------------

    test("waits (not consent) for a cloud user when the assistants list has not hydrated", () => {
      // Boot race: assistants and consent both start empty/false. Deciding
      // here would dump an established user into the onboarding funnel.
      expect(
        guard(
          s({
            hasAssistants: false,
            tosAccepted: false,
            privacyConsent: false,
            assistantsHydrated: false,
            consentHydrated: false,
          }),
        ),
      ).toEqual(WAIT);
    });

    test("waits for a cloud user when assistants hydrated but consent has not", () => {
      expect(
        guard(
          s({
            hasAssistants: false,
            tosAccepted: false,
            privacyConsent: false,
            assistantsHydrated: true,
            consentHydrated: false,
          }),
        ),
      ).toEqual(WAIT);
    });

    test("redirects to consent once both hydrated and consent is genuinely false", () => {
      expect(
        guard(
          s({
            hasAssistants: false,
            tosAccepted: false,
            privacyConsent: false,
            hasConsentRecord: false,
            assistantsHydrated: true,
            consentHydrated: true,
          }),
        ),
      ).toEqual({
        action: "redirect",
        to: "/account/consent?returnTo=%2Fassistant",
      });
    });

    test("waits (not consent) when consent looks stale but has not hydrated", () => {
      expect(
        guard(
          s({
            hasAssistants: true,
            privacyConsent: false,
            consentHydrated: false,
          }),
        ),
      ).toEqual(WAIT);
    });

    test("redirects to consent once hydrated consent is genuinely stale", () => {
      expect(
        guard(
          s({
            hasAssistants: true,
            privacyConsent: false,
            consentHydrated: true,
          }),
        ),
      ).toEqual({
        action: "redirect",
        to: "/account/consent?returnTo=%2Fassistant",
      });
    });

    test("local mode ignores hydration flags (lockfile-driven list, sync consent)", () => {
      // The no-assistants fork keys off the cloud probe, not hydration...
      expect(
        guard(
          s({
            isLocalClient: true,
            hasAssistants: false,
            cloudSession: "absent",
            assistantsHydrated: false,
            consentHydrated: false,
          }),
        ),
      ).toEqual({ action: "redirect", to: "/account/onboarding/welcome" });
      // ...and stale-consent enforcement decides immediately: the local paths
      // that enforce consent hydrate synchronously during session init.
      expect(
        guard(
          s({
            isLocalClient: true,
            hasAssistants: true,
            cloudSession: "present",
            tosAccepted: false,
            privacyConsent: false,
            consentHydrated: false,
          }),
        ),
      ).toEqual({
        action: "redirect",
        to: "/account/consent?returnTo=%2Fassistant",
      });
    });

    // -- stale consent toggles --------------------------------------------

    test("redirects platform user with stale privacy acceptance to consent", () => {
      expect(guard(s({ isLocalClient: false, privacyConsent: false }))).toEqual(
        {
          action: "redirect",
          to: "/account/consent?returnTo=%2Fassistant",
        },
      );
    });

    test("redirects platform user with stale tos acceptance to consent", () => {
      expect(guard(s({ isLocalClient: false, tosAccepted: false }))).toEqual({
        action: "redirect",
        to: "/account/consent?returnTo=%2Fassistant",
      });
    });

    test("allows platform user when all four consent flags are current", () => {
      expect(
        guard(
          s({
            isLocalClient: false,
            tosAccepted: true,
            privacyConsent: true,
          }),
        ),
      ).toEqual(ALLOW);
    });

    test("redirects local-mode user with a cloud session and stale consent to consent", () => {
      // Consent is gated on the cloud session, NOT isLocalClient: a local-mode
      // client logged into the cloud still re-reviews stale terms.
      expect(
        guard(
          s({
            isLocalClient: true,
            hasAssistants: true,
            cloudSession: "present",
            tosAccepted: false,
            privacyConsent: false,
          }),
        ),
      ).toEqual({
        action: "redirect",
        to: "/account/consent?returnTo=%2Fassistant",
      });
    });

    test("does not enforce consent when the cloud session is absent", () => {
      expect(
        guard(
          s({
            hasAssistants: true,
            cloudSession: "absent",
            tosAccepted: false,
            privacyConsent: false,
          }),
        ),
      ).toEqual(ALLOW);
    });

    // -- normal authenticated access --------------------------------------

    test("allows authenticated user on normal route", () => {
      expect(guard(s({}))).toEqual(ALLOW);
    });

    test("redirects authenticated platform user without assistants to hatching", () => {
      expect(guard(s({ hasAssistants: false }))).toEqual({
        action: "redirect",
        to: "/assistant/onboarding/hatching",
      });
    });

    test("redirects platform user with consent but no assistants to hatching from deep path", () => {
      expect(guard(s({ hasAssistants: false }), "/assistant/identity")).toEqual(
        {
          action: "redirect",
          to: "/assistant/onboarding/hatching",
        },
      );
    });

    test("redirects a consented no-assistant cloud user to hatching", () => {
      expect(guard(s({ hasAssistants: false }))).toEqual({
        action: "redirect",
        to: "/assistant/onboarding/hatching",
      });
    });

    test("redirects consented platform user with stale privacy acceptance and no assistant to consent, not hatching", () => {
      expect(guard(s({ hasAssistants: false, privacyConsent: false }))).toEqual(
        {
          action: "redirect",
          to: "/account/consent?returnTo=%2Fassistant",
        },
      );
    });

    test("redirects consented platform user with stale tos acceptance and no assistant to consent", () => {
      expect(
        guard(
          s({ hasAssistants: false, tosAccepted: false }),
          "/assistant/identity",
        ),
      ).toEqual({
        action: "redirect",
        to: "/account/consent?returnTo=%2Fassistant%2Fidentity",
      });
    });

    const UNCONSENTED = {
      tosAccepted: false,
      privacyConsent: false,
      hasConsentRecord: false,
    } as const;

    // A brand-new org: nothing resolved at all.
    const EMPTY_ORG = { hasAssistants: false } as const;

    // Consent is enforced at the destination, not skipped: both funnel entries
    // are onboarding paths, and re-resolving one bounces an unconsented cloud
    // user on.
    test("consent is still enforced once the funnel destination is resolved", () => {
      for (const url of [RESEARCH_FUNNEL_URL, HATCHING_FUNNEL_URL]) {
        expect(
          redirectPath(guard(s({ ...EMPTY_ORG, ...UNCONSENTED }), url)),
        ).toBe("/account/consent");
      }
    });

    // Every funnel bounce is the bare consent screen: the bounce reads no
    // `returnTo`.
    test("a hatching bounce keeps the bare consent screen", () => {
      for (const url of [
        "/assistant/onboarding/hatching",
        "/assistant/onboarding/hatching?hosting=cadet-cloud",
      ]) {
        expect(guard(s(UNCONSENTED), url)).toEqual({
          action: "redirect",
          to: "/account/consent",
        });
      }
    });

    // A local-only client has no session to consent against, so the funnel
    // gates let it through ungated.
    test("a local-only hatching visit is not consent-gated", () => {
      expect(
        guard(
          s({ isLocalClient: true, cloudSession: "absent", ...UNCONSENTED }),
          HATCHING_FUNNEL_URL,
        ),
      ).toEqual(ALLOW);
    });

    // The research funnel provisions an assistant, so an unconsented cloud
    // user does not reach it by navigating there directly either.
    test("bounces an unconsented bare research visit to the consent screen", () => {
      expect(guard(s(UNCONSENTED), "/assistant/onboarding/research")).toEqual({
        action: "redirect",
        to: "/account/consent",
      });
      expect(
        guard(
          s({ isLocalClient: true, cloudSession: "absent", ...UNCONSENTED }),
          "/assistant/onboarding/research",
        ),
      ).toEqual(ALLOW);
    });

    test("allows a consented user on the research route", () => {
      expect(guard(s({}), "/assistant/onboarding/research")).toEqual(ALLOW);
      expect(
        guard(s({ hasAssistants: false }), "/assistant/onboarding/research"),
      ).toEqual(ALLOW);
      expect(guard(s({}), RESEARCH_FUNNEL_URL)).toEqual(ALLOW);
    });

    // A cold deep link reaches the research route before the consent flags
    // hydrate, and they boot false — deciding there would bounce an
    // established user to consent, and a `redirect` gives the auth middleware
    // nothing to wait on.
    test("waits on the research route until consent hydrates", () => {
      for (const url of [
        "/assistant/onboarding/research",
        RESEARCH_FUNNEL_URL,
      ]) {
        expect(
          guard(
            s({ ...EMPTY_ORG, ...UNCONSENTED, consentHydrated: false }),
            url,
          ),
        ).toEqual(WAIT);
        // Same wait for an already-consented user whose flags have not been
        // confirmed yet: hydration is read before the flags either way.
        expect(guard(s({ consentHydrated: false }), url)).toEqual(WAIT);
      }
    });

    // The wait is research-only: the foreground hatching entry is reached from
    // in-app navigation, never a cold deep link, and it bounces immediately.
    test("the hatching bounce does not wait on consent hydration", () => {
      expect(
        guard(
          s({ ...UNCONSENTED, consentHydrated: false }),
          HATCHING_FUNNEL_URL,
        ),
      ).toEqual({
        action: "redirect",
        to: "/account/consent",
      });
    });

    // The auth middleware forces `consentHydrated` once its wait runs out, so
    // the flags underneath are still their boot `false`. Bouncing on them
    // evicts an already-consented user mid-funnel, so the research entry falls
    // back to the unconditional admission it had before it joined the funnel.
    test("admits the research route when consent hydration timed out", () => {
      for (const url of [
        "/assistant/onboarding/research",
        RESEARCH_FUNNEL_URL,
      ]) {
        expect(
          guard(
            s({
              ...EMPTY_ORG,
              ...UNCONSENTED,
              consentHydrated: true,
              consentHydrationTimedOut: true,
            }),
            url,
          ),
        ).toEqual(ALLOW);
      }
      // The stale-toggle gate reads the same unhydrated flags, so it fails
      // open too.
      expect(
        guard(
          s({
            ...EMPTY_ORG,
            privacyConsent: false,
            consentHydrated: true,
            consentHydrationTimedOut: true,
          }),
          RESEARCH_FUNNEL_URL,
        ),
      ).toEqual(ALLOW);
    });

    // Fail-open is scoped to the unhydrated read: a hydration that actually
    // landed on an unconsented user still bounces.
    test("still bounces a genuinely hydrated unconsented research visit", () => {
      expect(
        guard(s({ ...EMPTY_ORG, ...UNCONSENTED }), RESEARCH_FUNNEL_URL),
      ).toEqual({
        action: "redirect",
        to: "/account/consent",
      });
    });

    // The hatching entry never waits on hydration, so it never sees the forced
    // flag either — its bounce is unchanged by the fail-open.
    test("the hatching bounce is unaffected by a consent hydration timeout", () => {
      expect(
        guard(
          s({
            ...UNCONSENTED,
            consentHydrated: true,
            consentHydrationTimedOut: true,
          }),
          HATCHING_FUNNEL_URL,
        ),
      ).toEqual({
        action: "redirect",
        to: "/account/consent",
      });
    });

    // Local mode is excluded from hydration waits everywhere in the pipeline —
    // its consent hydrates during session init or not at all — so a
    // cloud-session research bounce decides immediately.
    test("a local-mode research bounce decides without waiting on hydration", () => {
      expect(
        guard(
          s({ isLocalClient: true, ...UNCONSENTED, consentHydrated: false }),
          RESEARCH_FUNNEL_URL,
        ),
      ).toEqual({ action: "redirect", to: "/account/consent" });
      expect(
        guard(
          s({ isLocalClient: true, ...UNCONSENTED, consentHydrated: false }),
          "/assistant/onboarding/research",
        ),
      ).toEqual({ action: "redirect", to: "/account/consent" });
    });

    test("redirects brand-new platform user with no assistant to consent, unaffected by stale-toggle gate", () => {
      expect(
        guard(
          s({
            hasAssistants: false,
            tosAccepted: false,
            privacyConsent: false,
            hasConsentRecord: false,
          }),
        ),
      ).toEqual({
        action: "redirect",
        to: "/account/consent?returnTo=%2Fassistant",
      });
    });
  });

  // -----------------------------------------------------------------------
  // onboarding-intercept
  // -----------------------------------------------------------------------
  describe("onboarding-intercept", () => {
    const intercept = (state: NavigationState, dest: string) =>
      resolveNavigation(state, {
        kind: "onboarding-intercept",
        intendedDestination: dest,
      });

    test("allows local mode with assistants", () => {
      expect(
        intercept(
          s({ isLocalClient: true, hasAssistants: true }),
          "/assistant",
        ),
      ).toEqual(ALLOW);
    });

    test("allows when tos and consent accepted", () => {
      expect(
        intercept(s({ tosAccepted: true, privacyConsent: true }), "/assistant"),
      ).toEqual(ALLOW);
    });

    test("allows a returning user even without local consent flags", () => {
      expect(
        intercept(
          s({
            userHasOnboardedAssistant: true,
            tosAccepted: false,
            privacyConsent: false,
          }),
          "/assistant",
        ),
      ).toEqual(ALLOW);
    });

    test("stale toggles do not change onboarding-intercept (hasCompletedOnboarding only)", () => {
      expect(
        intercept(
          s({
            privacyConsent: false,
          }),
          "/assistant",
        ),
      ).toEqual(ALLOW);
    });

    test("allows destination outside /assistant", () => {
      expect(
        intercept(
          s({ tosAccepted: false, privacyConsent: false }),
          "/account/login",
        ),
      ).toEqual(ALLOW);
    });

    test("allows destination in /assistant/onboarding", () => {
      expect(
        intercept(
          s({ tosAccepted: false, privacyConsent: false }),
          "/assistant/onboarding/hatching",
        ),
      ).toEqual(ALLOW);
    });

    test("redirects to welcome in local mode", () => {
      expect(
        intercept(
          s({
            isLocalClient: true,
            hasAssistants: false,
            tosAccepted: false,
            privacyConsent: false,
            hasConsentRecord: false,
          }),
          "/assistant",
        ),
      ).toEqual({ action: "redirect", to: "/account/onboarding/welcome" });
    });

    test("redirects to consent in platform mode", () => {
      expect(
        intercept(
          s({
            tosAccepted: false,
            privacyConsent: false,
            hasConsentRecord: false,
          }),
          "/assistant",
        ),
      ).toEqual({
        action: "redirect",
        to: "/account/consent",
      });
    });

    test("handles absolute URL destinations", () => {
      expect(
        intercept(
          s({
            tosAccepted: false,
            privacyConsent: false,
            hasConsentRecord: false,
          }),
          "https://mycadet.ai/assistant",
        ),
      ).toEqual({ action: "redirect", to: "/account/consent" });
    });

    test("handles protocol-relative URL destinations", () => {
      expect(
        intercept(
          s({
            tosAccepted: false,
            privacyConsent: false,
            hasConsentRecord: false,
          }),
          "//mycadet.ai/assistant",
        ),
      ).toEqual({ action: "redirect", to: "/account/consent" });
    });

    test("allows absolute URL outside /assistant", () => {
      expect(
        intercept(
          s({ tosAccepted: false, privacyConsent: false }),
          "https://mycadet.ai/account",
        ),
      ).toEqual(ALLOW);
    });
  });

  // -----------------------------------------------------------------------
  // hatch-gate
  // -----------------------------------------------------------------------
  describe("hatch-gate", () => {
    const hatch = (state: NavigationState) =>
      resolveNavigation(state, { kind: "hatch-gate" });

    test("waits when session not settled", () => {
      expect(hatch(s({ sessionSettled: false }))).toEqual(WAIT);
    });

    test("redirects unauthenticated platform-mode user to the pairing page", () => {
      expect(
        hatch(s({ isAuthenticated: false, isLocalClient: false })),
      ).toEqual({
        action: "redirect",
        to: "/assistant/pair",
      });
    });

    test("does not gate an unauthenticated local-mode user without consent", () => {
      // Consent is a cloud-account concern: with no session to consent
      // against, a local-only client is not gated here.
      expect(
        hatch(
          s({
            isAuthenticated: false,
            isLocalClient: true,
            cloudSession: "absent",
            tosAccepted: false,
            privacyConsent: false,
            hasConsentRecord: false,
          }),
        ),
      ).toEqual(ALLOW);
    });

    test("redirects when missing consent", () => {
      expect(
        hatch(
          s({
            tosAccepted: false,
            privacyConsent: false,
            hasConsentRecord: false,
          }),
        ),
      ).toEqual({
        action: "redirect",
        to: "/account/consent",
      });
    });

    test("redirects when missing ai data consent only", () => {
      expect(
        hatch(
          s({
            tosAccepted: true,
            privacyConsent: false,
            hasConsentRecord: false,
          }),
        ),
      ).toEqual({
        action: "redirect",
        to: "/account/consent",
      });
    });

    test("does not gate a local-only user missing consent", () => {
      expect(
        hatch(
          s({
            isLocalClient: true,
            cloudSession: "absent",
            tosAccepted: false,
            privacyConsent: false,
            hasConsentRecord: false,
          }),
        ),
      ).toEqual(ALLOW);
    });

    test("allows with full consent", () => {
      expect(hatch(s({ tosAccepted: true, privacyConsent: true }))).toEqual(
        ALLOW,
      );
    });

    test("redirects platform user with stale privacy acceptance to consent", () => {
      expect(hatch(s({ privacyConsent: false }))).toEqual({
        action: "redirect",
        to: "/account/consent",
      });
    });

    test("redirects platform user with stale tos acceptance to consent", () => {
      expect(hatch(s({ tosAccepted: false }))).toEqual({
        action: "redirect",
        to: "/account/consent",
      });
    });

    test("gates a local-mode user WITH a cloud session on stale toggles", () => {
      // Consent is gated on the cloud session, not isLocalClient: a
      // local-mode client logged into the cloud still re-reviews.
      expect(
        hatch(
          s({
            isLocalClient: true,
            cloudSession: "present",
            privacyConsent: false,
          }),
        ),
      ).toEqual({
        action: "redirect",
        to: "/account/consent",
      });
    });

    test("does not gate a local-only user on stale toggles", () => {
      expect(
        hatch(
          s({
            isLocalClient: true,
            cloudSession: "absent",
            privacyConsent: false,
          }),
        ),
      ).toEqual(ALLOW);
    });
  });

  // -----------------------------------------------------------------------
  // post-retire
  // -----------------------------------------------------------------------
  describe("post-retire", () => {
    const postRetire = (state: NavigationState) =>
      resolveNavigation(state, { kind: "post-retire" });

    test("redirects to the assistant in local mode when other assistants remain", () => {
      expect(
        postRetire(s({ hasAssistants: true, isLocalClient: true })),
      ).toEqual({
        action: "redirect",
        to: "/assistant",
      });
    });

    test("redirects to /assistant in platform mode when other assistants remain", () => {
      expect(
        postRetire(s({ hasAssistants: true, isLocalClient: false })),
      ).toEqual({
        action: "redirect",
        to: "/assistant",
      });
    });

    test("redirects to research in platform mode when no assistants remain", () => {
      expect(
        postRetire(s({ hasAssistants: false, isLocalClient: false })),
      ).toEqual({
        action: "redirect",
        to: "/assistant/onboarding/research",
      });
    });

    test("redirects to hosting in local mode when platform session present", () => {
      expect(
        postRetire(
          s({
            hasAssistants: false,
            isLocalClient: true,
            cloudSession: "present",
          }),
        ),
      ).toEqual({
        action: "redirect",
        to: "/account/onboarding/hosting",
      });
    });

    test("redirects to welcome in local mode when no platform session", () => {
      expect(
        postRetire(
          s({
            hasAssistants: false,
            isLocalClient: true,
            cloudSession: "absent",
          }),
        ),
      ).toEqual({
        action: "redirect",
        to: "/account/onboarding/welcome",
      });
    });
  });

  // -----------------------------------------------------------------------
  // post-auth
  // -----------------------------------------------------------------------
  describe("post-auth", () => {
    beforeEach(() => {
      sessionStorage.clear();
    });

    const postAuth = (
      authIntent: "login" | "signup",
      returnTo: string | null,
      fallback = "/assistant",
    ) =>
      resolveNavigation(base, {
        kind: "post-auth",
        authIntent,
        returnTo,
        fallback,
      });

    test("signup goes to consent for non-import returnTo", () => {
      expect(postAuth("signup", "/some-return")).toEqual({
        action: "redirect",
        to: consentCarry(),
      });
    });

    test("signup goes to consent without returnTo", () => {
      expect(postAuth("signup", null)).toEqual({
        action: "redirect",
        to: consentCarry(),
      });
    });

    test("signup honors an import-funnel returnTo, query preserved", () => {
      expect(
        postAuth("signup", "/import?utm_source=hermes&import=hermes"),
      ).toEqual({
        action: "redirect",
        to: "/import?utm_source=hermes&import=hermes",
      });
      expect(postAuth("signup", "/import")).toEqual({
        action: "redirect",
        to: "/import",
      });
    });

    test("signup does not treat import-prefixed pages as the funnel", () => {
      expect(postAuth("signup", "/importantly-not-the-funnel")).toEqual({
        action: "redirect",
        to: consentCarry(),
      });
    });

    test("login uses returnTo", () => {
      expect(postAuth("login", "/assistant/identity")).toEqual({
        action: "redirect",
        to: "/assistant/identity",
      });
    });

    test("login falls back when returnTo is null", () => {
      expect(postAuth("login", null)).toEqual({
        action: "redirect",
        to: "/assistant",
      });
    });

    test("login falls back when returnTo is empty", () => {
      expect(postAuth("login", "")).toEqual({
        action: "redirect",
        to: "/assistant",
      });
    });

    test("signup skips privacy when the assistant is already onboarded", () => {
      expect(
        resolveNavigation(s({ userHasOnboardedAssistant: true }), {
          kind: "post-auth",
          authIntent: "signup",
          returnTo: "/assistant/identity",
          fallback: "/assistant",
        }),
      ).toEqual({ action: "redirect", to: "/assistant/identity" });
    });

    test("login keeps an onboarding returnTo when already onboarded", () => {
      expect(
        resolveNavigation(s({ userHasOnboardedAssistant: true }), {
          kind: "post-auth",
          authIntent: "login",
          returnTo: HATCHING_FUNNEL_URL,
          fallback: "/assistant",
        }),
      ).toEqual({ action: "redirect", to: HATCHING_FUNNEL_URL });
    });

    test("login skips a research returnTo when already onboarded", () => {
      expect(
        resolveNavigation(s({ userHasOnboardedAssistant: true }), {
          kind: "post-auth",
          authIntent: "login",
          returnTo: "/assistant/onboarding/research",
          fallback: "/assistant",
        }),
      ).toEqual({ action: "redirect", to: "/assistant" });
      expect(
        resolveNavigation(s({ userHasOnboardedAssistant: true }), {
          kind: "post-auth",
          authIntent: "login",
          returnTo: "/assistant/onboarding/research?hosting=cadet-cloud",
          fallback: "/assistant",
        }),
      ).toEqual({ action: "redirect", to: "/assistant" });
    });

    test("login keeps a new-assistant returnTo when already onboarded", () => {
      const returnTo = `/assistant/onboarding/research?${NEW_ASSISTANT_PARAM}=1`;
      expect(
        resolveNavigation(s({ userHasOnboardedAssistant: true }), {
          kind: "post-auth",
          authIntent: "login",
          returnTo,
          fallback: "/assistant",
        }),
      ).toEqual({ action: "redirect", to: returnTo });
    });

    test("signup still goes to consent for a freshly hatched assistant", () => {
      expect(
        resolveNavigation(
          s({ userHasOnboardedAssistant: false, hasAssistants: true }),
          {
            kind: "post-auth",
            authIntent: "signup",
            returnTo: "/assistant/identity",
            fallback: "/assistant",
          },
        ),
      ).toEqual({
        action: "redirect",
        // Non-production build: the post-consent destination skips research.
        to: `/account/consent?returnTo=${encodeURIComponent(
          "/assistant/onboarding/hatching?skip_research=1",
        )}`,
      });
    });
  });

  // -----------------------------------------------------------------------
  // resolveLoginReturnTo
  // -----------------------------------------------------------------------
  describe("resolveLoginReturnTo", () => {
    test("returns hosting from welcome when no assistants", () => {
      expect(
        resolveLoginReturnTo(
          s({ hasAssistants: false }),
          "/account/onboarding/hosting",
        ),
      ).toBe("/account/onboarding/hosting");
    });

    test("returns the same path for other non-welcome pages", () => {
      expect(resolveLoginReturnTo(s({}), "/account/onboarding/hosting")).toBe(
        "/account/onboarding/hosting",
      );
    });
  });
});
