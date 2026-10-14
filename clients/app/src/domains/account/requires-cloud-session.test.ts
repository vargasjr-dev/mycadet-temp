import { expect, test } from "bun:test";
import { requiresCloudSession } from "./requires-cloud-session";
import { isPaidProvisioningReturn } from "./paid-provisioning-return";
import { requiresCloudSession as webRequiresCloudSession } from "@web/domains/account/login-flow";

const cases: [string, boolean][] = [
  ["/assistant", false],
  ["/assistant/settings/usage", false],
  ["/assistant/settings/usage?tab=billing", false],
  ["/assistant/settings/usage?session_id=paid", true],
  ["/assistant/settings/usage?session_id=", true],
  ["/assistant/settings/usage/other?session_id=paid", false],
  ["/assistant/checkout?package=super", true],
  ["/assistant/plans/details", true],
  ["/assistant/settings/billing/upgrade/success", true],
  ["/assistant/settings/billingish", false],
  ["/account/login", true],
  ["/accounting", false],
  ["/accounts/cli/callback", true],
  ["/v1/account", true],
  ["/_allauth/browser/v1/auth/session", true],
  ["/import?source=campaign", true],
  ["https://www.mycadet.ai/account", true],
  ["/assistant/onboarding/research?hosting=cadet-cloud", false],
  ["/assistant/onboarding/research?post_checkout=1", true],
  ["/assistant/onboarding/hatching?post_checkout=1", true],
  ["/assistant/onboarding/research?post_checkout=true", false],
  ["/assistant/onboarding/privacy?post_checkout=1", false],
];
for (const [destination, expected] of cases) {
  test(`session requirement for ${destination}`, () => {
    expect(requiresCloudSession(destination)).toBe(expected);
    expect(requiresCloudSession(destination)).toBe(
      webRequiresCloudSession(destination),
    );
  });
}
test("paid provisioning recognizes only safe, exact provisioning paths", () => {
  for (const path of [
    "https://evil.example/assistant/onboarding/research?post_checkout=1",
    "//evil.example/assistant/onboarding/hatching?post_checkout=1",
    "/assistant/onboarding/research/extra?post_checkout=1",
    "/assistant/onboarding/research?post_checkout=0&post_checkout=1",
  ]) {
    expect(isPaidProvisioningReturn(path)).toBe(false);
  }
});
