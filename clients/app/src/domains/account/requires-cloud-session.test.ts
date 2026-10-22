import { expect, test } from "bun:test";
import { requiresCloudSession } from "./requires-cloud-session";
import { requiresCloudSession as webRequiresCloudSession } from "@web/domains/account/login-flow";

const cases: [string, boolean][] = [
  ["/assistant", false],
  ["/assistant/settings/usage", false],
  ["/assistant/settings/usage?tab=billing", false],
  ["/assistant/settings/usage?session_id=paid", false],
  ["/assistant/checkout?package=super", false],
  ["/assistant/plans/details", false],
  ["/assistant/settings/billingish", false],
  ["/account/login", true],
  ["/accounting", false],
  ["/accounts/cli/callback", true],
  ["/v1/account", true],
  ["/_allauth/browser/v1/auth/session", true],
  ["/import?source=campaign", true],
  ["https://www.mycadet.ai/account", true],
  ["/account/profile/subpage", true],
  ["/assistant/onboarding/research?hosting=cadet-cloud", false],
];
for (const [destination, expected] of cases) {
  test(`session requirement for ${destination}`, () => {
    expect(requiresCloudSession(destination)).toBe(expected);
    expect(requiresCloudSession(destination)).toBe(
      webRequiresCloudSession(destination),
    );
  });
}
