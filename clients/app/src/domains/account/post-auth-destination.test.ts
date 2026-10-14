import { beforeEach, expect, test } from "bun:test";
import { resolvePostAuthDestination } from "./post-auth-destination";
import type { SignupCheckoutIntent } from "@app/lib/billing/checkout-intent";
import {
  resolveNavigation,
  type NavigationState,
} from "@web/lib/navigation/navigation-resolver";
let saved: SignupCheckoutIntent | null = null;
const checkout = {
  save: (value: SignupCheckoutIntent) => {
    saved = value;
  },
  clear: () => {
    saved = null;
  },
};
beforeEach(() => {
  saved = null;
});
const state: NavigationState = {
  isLocalClient: false,
  isCloudDisabled: false,
  isRemoteGateway: false,
  remoteGatewayPublicPathPrefix: "",
  isGatewayAuth: false,
  hasAssistants: false,
  hasCloudHostedAssistant: false,
  sessionSettled: true,
  isAuthenticated: true,
  cloudSession: "present",
  tosAccepted: true,
  privacyConsent: true,
  analyticsConsentCurrent: true,
  diagnosticsConsentCurrent: true,
  consentHydrated: true,
  assistantsHydrated: true,
  userHasOnboardedAssistant: false,
  selectedAssistantOnboarded: false,
};
for (const returningUser of [false, true]) {
  for (const authIntent of ["login", "signup"] as const) {
    test(`${authIntent} preserves the composed web return contract for returning=${returningUser}`, () => {
      for (const returnTo of [
        null,
        "",
        "/assistant",
        "/assistant/identity",
        "/assistant/checkout?package=super",
        "/assistant/checkout?storage_tier=s&credit_tier=credits_25",
        "/assistant/onboarding/privacy",
        "/assistant/onboarding/research?hosting=cadet-cloud",
        "/assistant/onboarding/research?post_checkout=1",
        "/assistant/onboarding/privacy?new_assistant=1",
        "/assistant/onboarding/research?new_assistant=1",
        "/import",
        "/import?utm_source=campaign",
        "/import/hermes",
        "/importantly-not-the-funnel",
        "/accounts/cli/callback?port=54321&state=example",
        "https://www.mycadet.ai/assistant/onboarding/privacy?new_assistant=1",
        "https://www.mycadet.ai/assistant/onboarding/research",
        "https://evil.example",
        "//evil.example",
      ]) {
        const args = { returnTo, authIntent, fallback: "/assistant" };
        const web = resolveNavigation(
          { ...state, userHasOnboardedAssistant: returningUser },
          { kind: "post-auth", ...args },
        );
        expect(web.action).toBe("redirect");
        if (web.action === "redirect") {
          expect(
            resolvePostAuthDestination(args, { returningUser, checkout })
              .destination,
          ).toBe(web.to);
        }
      }
    });
  }
}
test("fresh signup carries a marked checkout selection to assistant consent", () => {
  expect(
    resolvePostAuthDestination(
      {
        authIntent: "signup",
        returnTo: "/assistant/checkout?package=super",
        fallback: "/account",
      },
      { returningUser: false, checkout },
    ),
  ).toEqual({
    destination: "/assistant/onboarding/privacy",
    requiresFullPageNavigation: false,
  });
  expect(saved).toEqual({
    kind: "package",
    packageKey: "super",
    resumeAfterOnboarding: true,
  });
});
test("returning signup treats checkout as login and does not create a consent carry", () => {
  const destination = "/assistant/checkout?package=super";
  expect(
    resolvePostAuthDestination(
      { authIntent: "signup", returnTo: destination, fallback: "/account" },
      { returningUser: true, checkout },
    ).destination,
  ).toBe(destination);
  expect(saved).toBeNull();
});
test("import signup and cloud account callbacks require full-page navigation", () => {
  expect(
    resolvePostAuthDestination(
      { authIntent: "signup", returnTo: "/import?foo=1", fallback: "/account" },
      { returningUser: false, checkout },
    ),
  ).toEqual({ destination: "/import?foo=1", requiresFullPageNavigation: true });
  expect(
    resolvePostAuthDestination(
      {
        authIntent: "login",
        returnTo: "/accounts/cli/callback?port=54321",
        fallback: "/account",
      },
      { returningUser: false, checkout },
    ).requiresFullPageNavigation,
  ).toBe(true);
});
