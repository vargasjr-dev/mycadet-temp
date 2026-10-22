import { beforeEach, describe, expect, mock, test } from "bun:test";

import { onboardingCompletedMiddleware } from "@/lib/onboarding-middleware";
import { useAuthStore } from "@/stores/auth-store";
import { useOnboardingStore } from "@/domains/onboarding/onboarding-store";
import { routes } from "@/utils/routes";

function makeRequest(path: string): Request {
  return new Request(`https://example.com${path}`);
}

describe("onboardingCompletedMiddleware", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    useAuthStore.setState({ cloudSession: "absent" });
    useOnboardingStore.setState({
      tosAccepted: true,
      privacyConsent: true,
      hasConsentRecord: true,
      consentHydrated: true,
    });
  });

  test("admits the hatching entry for a settled user with the fail marker", async () => {
    // Developer "Replay Hatch Failure" tool: the hatching screen
    // short-circuits straight to its error UI when `fail` is present (no real
    // hatch side effects), so it's safe to let preview through for that one
    // case only.
    useAuthStore.setState({ cloudSession: "absent" });
    const next = mock(async () => "ok");

    const result = await onboardingCompletedMiddleware(
      {
        request: makeRequest(
          `${routes.onboarding.hatching}?preview=true&fail=1`,
        ),
      } as Parameters<typeof onboardingCompletedMiddleware>[0],
      next,
    );

    expect(result).toBe("ok");
    expect(next).toHaveBeenCalled();
  });

  test("runs the route guard when preview lacks the fail marker", async () => {
    // An unconsented cloud user's bounce is a full-page navigation to the
    // shell's consent screen — the guard ran; the SPA just doesn't survive it.
    useAuthStore.setState({
      cloudSession: "present",
      sessionStatus: "authenticated",
      user: { id: "u1", email: "u1@x" } as never,
    });
    useOnboardingStore.setState({
      tosAccepted: false,
      privacyConsent: false,
      hasConsentRecord: false,
      consentHydrated: true,
    });
    const next = mock(async () => "ok");

    const result = await onboardingCompletedMiddleware(
      {
        request: makeRequest(`${routes.onboarding.hatching}?preview=true`),
      } as Parameters<typeof onboardingCompletedMiddleware>[0],
      next,
    );

    expect(result).toBe("ok");
    expect(next).toHaveBeenCalled();
    expect(window.location.href.endsWith("/account/consent")).toBe(true);
  });
});
