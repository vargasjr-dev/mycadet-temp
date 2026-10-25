import { beforeEach, describe, test, expect } from "bun:test";
import { NEW_ASSISTANT_PARAM } from "@/domains/onboarding/onboarding-destination";
import { resolveNavigation, type NavigationState, type NavigationDecision } from "./navigation-resolver";

const base: NavigationState = {
  isLocalClient: false,
  isRemoteGateway: false,
  remoteGatewayPublicPathPrefix: "",
  isGatewaySessionLive: false,
  hasAssistants: true,
  sessionSettled: true,
  isAuthenticated: true,
  cloudSession: "present",
  assistantsHydrated: true,
  userHasOnboardedAssistant: false,
  selectedAssistantOnboarded: false,
};
const s = (overrides: Partial<NavigationState>): NavigationState => ({ ...base, ...overrides });
const ALLOW: NavigationDecision = { action: "allow" };
const WAIT: NavigationDecision = { action: "wait" };
const HATCHING_FUNNEL_URL = "/account/onboarding/hatching?hosting=cadet-cloud";
const consentCarry = () =>
  `/account/consent?returnTo=${encodeURIComponent("/assistant/onboarding/research")}`;

describe("resolveNavigation", () => {
  describe("route-guard", () => {
    const guard = (state: NavigationState, pathname = "/assistant") =>
      resolveNavigation(state, { kind: "route-guard", pathname });

    test("waits for session initialization", () => {
      expect(guard(s({ sessionSettled: false }))).toEqual(WAIT);
    });

    test("pairs an unauthenticated browser and preserves its destination", () => {
      expect(guard(s({ isAuthenticated: false }), "/assistant/identity?tab=1")).toEqual({
        action: "redirect",
        to: "/assistant/pair?returnTo=%2Fassistant%2Fidentity%3Ftab%3D1",
      });
    });

    test("remote pairing is required even when the auth store reports authenticated", () => {
      expect(guard(s({
        isRemoteGateway: true,
        isLocalClient: true,
        remoteGatewayPublicPathPrefix: "/assistant-123",
      }), "/assistant-123/assistant/conversations/self?tab=latest")).toEqual({
        action: "redirect",
        to: "/assistant/pair?returnTo=%2Fassistant%2Fconversations%2Fself%3Ftab%3Dlatest",
      });
    });

    test("a live gateway session admits before the auth store catches up", () => {
      expect(guard(s({
        isRemoteGateway: true,
        isLocalClient: true,
        isGatewaySessionLive: true,
        isAuthenticated: false,
      }))).toEqual(ALLOW);
    });

    test("local clients without a session choose welcome or their existing assistant", () => {
      expect(guard(s({ isLocalClient: true, isAuthenticated: false, hasAssistants: false }))).toEqual({
        action: "redirect", to: "/account/onboarding/welcome",
      });
      expect(guard(s({ isLocalClient: true, isAuthenticated: false }))).toEqual({
        action: "redirect", to: "/assistant",
      });
    });

    test("empty local clients wait for the platform probe before choosing hosting", () => {
      expect(guard(s({ isLocalClient: true, hasAssistants: false, cloudSession: "unknown" }))).toEqual({
        action: "wait", waitFor: "cloud-session",
      });
      expect(guard(s({ isLocalClient: true, hasAssistants: false }))).toEqual({
        action: "redirect", to: "/account/onboarding/hosting",
      });
      expect(guard(s({ isLocalClient: true, hasAssistants: false, cloudSession: "absent" }))).toEqual({
        action: "redirect", to: "/account/onboarding/welcome",
      });
    });

    test("platform clients wait for assistants, then route an empty list to shell hatching", () => {
      expect(guard(s({ hasAssistants: false, assistantsHydrated: false }))).toEqual(WAIT);
      expect(guard(s({ hasAssistants: false }), "/assistant/identity")).toEqual({
        action: "redirect", to: "/account/onboarding/hatching",
      });
    });

    test("authenticated users with assistants are admitted", () => {
      expect(guard(base)).toEqual(ALLOW);
      expect(guard(s({ isLocalClient: true }))).toEqual(ALLOW);
    });

    test("provisioning entries do not read or wait on web consent", () => {
      for (const pathname of [
        "/assistant/onboarding/research?hosting=cadet-cloud",
        HATCHING_FUNNEL_URL,
      ]) {
        for (const isLocalClient of [false, true]) {
          expect(guard(s({
            isLocalClient,
            hasAssistants: false,
            assistantsHydrated: false,
          }), pathname)).toEqual(ALLOW);
        }
      }
    });
  });

  describe("onboarding-intercept", () => {
    const intercept = (state: NavigationState, intendedDestination: string) =>
      resolveNavigation(state, { kind: "onboarding-intercept", intendedDestination });

    test("an existing assistant admits without account consent state", () => {
      expect(intercept(base, "/assistant")).toEqual(ALLOW);
    });

    test("empty clients choose their onboarding entry", () => {
      expect(intercept(s({ hasAssistants: false }), "/assistant")).toEqual({
        action: "redirect", to: "/assistant/onboarding/research",
      });
      expect(intercept(s({ hasAssistants: false, isLocalClient: true }), "/assistant")).toEqual({
        action: "redirect", to: "/account/onboarding/welcome",
      });
    });

    test("non-assistant destinations and onboarding destinations remain reachable", () => {
      for (const destination of ["/account/login", "/assistant/onboarding/research", "https://mycadet.ai/account"]) {
        expect(intercept(s({ hasAssistants: false }), destination)).toEqual(ALLOW);
      }
    });

    test("absolute assistant destinations use the same empty-client fork", () => {
      for (const destination of ["https://mycadet.ai/assistant", "//mycadet.ai/assistant"]) {
        expect(intercept(s({ hasAssistants: false }), destination)).toEqual({
          action: "redirect", to: "/assistant/onboarding/research",
        });
      }
    });
  });

  describe("hatch-gate", () => {
    const hatch = (state: NavigationState) => resolveNavigation(state, { kind: "hatch-gate" });
    test("waits for the session and pairs unauthenticated platform users", () => {
      expect(hatch(s({ sessionSettled: false }))).toEqual(WAIT);
      expect(hatch(s({ isAuthenticated: false }))).toEqual({
        action: "redirect", to: "/assistant/pair",
      });
    });
    test("allows authenticated and local sessions without web consent state", () => {
      expect(hatch(base)).toEqual(ALLOW);
      expect(hatch(s({ isLocalClient: true, isAuthenticated: false, cloudSession: "absent" }))).toEqual(ALLOW);
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
        to: `/account/consent?returnTo=${encodeURIComponent(
          "/assistant/onboarding/research",
        )}`,
      });
    });
  });
});
