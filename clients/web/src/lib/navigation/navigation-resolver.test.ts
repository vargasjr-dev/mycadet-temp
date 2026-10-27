import { beforeEach, describe, test, expect, mock } from "bun:test";
import { NEW_ASSISTANT_PARAM } from "@/lib/navigation/onboarding-destination";
import type { NavigationState } from "./build-state";

const base: NavigationState = {
  isLocalClient: false,
  hasAssistants: true,
  userHasOnboardedAssistant: false,
  selectedAssistantOnboarded: false,
};
const s = (overrides: Partial<NavigationState>): NavigationState => ({
  ...base,
  ...overrides,
});

// The resolver builds its own state; the mock hands it the synthetic state
// each test installs.
let state: NavigationState = base;
mock.module("./build-state", () => ({
  buildNavigationState: () => state,
}));

const { resolveNavigation } = await import("./navigation-resolver");
type NavigationDecision = Awaited<
  ReturnType<typeof resolveNavigation>
>;

const ALLOW: NavigationDecision = { action: "allow" };
const HATCHING_FUNNEL_URL = "/account/onboarding/hatching?hosting=cadet-cloud";
const consentCarry = () =>
  `/account/consent?returnTo=${encodeURIComponent("/assistant/onboarding/research")}`;

describe("resolveNavigation", () => {
  beforeEach(() => {
    state = { ...base };
  });

  describe("route-guard", () => {
    const guard = (next: NavigationState, pathname = "/assistant") => {
      state = next;
      return resolveNavigation({ kind: "route-guard", pathname });
    };

    test("empty local clients route to hosting, which settles the account question itself", () => {
      expect(guard(s({ isLocalClient: true, hasAssistants: false }))).toEqual({
        action: "redirect",
        to: "/account/onboarding/hosting",
      });
    });

    test("platform clients route an empty roster to shell hatching — the middleware awaited the boot resolution first", () => {
      expect(guard(s({ hasAssistants: false }), "/assistant/identity")).toEqual(
        {
          action: "redirect",
          to: "/account/onboarding/hatching",
        },
      );
    });

    test("users with assistants are admitted", () => {
      expect(guard(base)).toEqual(ALLOW);
      expect(guard(s({ isLocalClient: true }))).toEqual(ALLOW);
    });

    test("provisioning entries do not read or wait on web consent", () => {
      for (const pathname of [
        "/assistant/onboarding/research?hosting=cadet-cloud",
        HATCHING_FUNNEL_URL,
      ]) {
        for (const isLocalClient of [false, true]) {
          expect(
            guard(
              s({
                isLocalClient,
                hasAssistants: false,
              }),
              pathname,
            ),
          ).toEqual(ALLOW);
        }
      }
    });
  });

  describe("post-retire", () => {
    const postRetire = (next: NavigationState) => {
      state = next;
      return resolveNavigation({ kind: "post-retire" });
    };

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

    test("redirects to hosting in local mode when no assistants remain", () => {
      expect(postRetire(s({ hasAssistants: false, isLocalClient: true }))).toEqual(
        {
          action: "redirect",
          to: "/account/onboarding/hosting",
        },
      );
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
      resolveNavigation({
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
      state = s({ userHasOnboardedAssistant: true });
      expect(
        resolveNavigation({
          kind: "post-auth",
          authIntent: "signup",
          returnTo: "/assistant/identity",
          fallback: "/assistant",
        }),
      ).toEqual({ action: "redirect", to: "/assistant/identity" });
    });

    test("login keeps an onboarding returnTo when already onboarded", () => {
      state = s({ userHasOnboardedAssistant: true });
      expect(
        resolveNavigation({
          kind: "post-auth",
          authIntent: "login",
          returnTo: HATCHING_FUNNEL_URL,
          fallback: "/assistant",
        }),
      ).toEqual({ action: "redirect", to: HATCHING_FUNNEL_URL });
    });

    test("login skips a research returnTo when already onboarded", () => {
      state = s({ userHasOnboardedAssistant: true });
      expect(
        resolveNavigation({
          kind: "post-auth",
          authIntent: "login",
          returnTo: "/assistant/onboarding/research",
          fallback: "/assistant",
        }),
      ).toEqual({ action: "redirect", to: "/assistant" });
      expect(
        resolveNavigation({
          kind: "post-auth",
          authIntent: "login",
          returnTo: "/assistant/onboarding/research?hosting=cadet-cloud",
          fallback: "/assistant",
        }),
      ).toEqual({ action: "redirect", to: "/assistant" });
    });

    test("login keeps a new-assistant returnTo when already onboarded", () => {
      const returnTo = `/assistant/onboarding/research?${NEW_ASSISTANT_PARAM}=1`;
      state = s({ userHasOnboardedAssistant: true });
      expect(
        resolveNavigation({
          kind: "post-auth",
          authIntent: "login",
          returnTo,
          fallback: "/assistant",
        }),
      ).toEqual({ action: "redirect", to: returnTo });
    });

    test("signup still goes to consent for a freshly hatched assistant", () => {
      state = s({ userHasOnboardedAssistant: false, hasAssistants: true });
      expect(
        resolveNavigation({
          kind: "post-auth",
          authIntent: "signup",
          returnTo: "/assistant/identity",
          fallback: "/assistant",
        }),
      ).toEqual({
        action: "redirect",
        to: `/account/consent?returnTo=${encodeURIComponent(
          "/assistant/onboarding/research",
        )}`,
      });
    });
  });
});
