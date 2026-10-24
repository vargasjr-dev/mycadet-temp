import { describe, expect, test } from "bun:test";

import { shouldDeferRootTopInset } from "@/utils/root-top-inset";
import { routes } from "@/utils/routes";

describe("shouldDeferRootTopInset", () => {
  test("suppresses onboarding funnel routes", () => {
    // The hosting/api-key/hatching steps moved to the app bundle; the funnel
    // surface web still renders is the /assistant/onboarding prefix.
    expect(shouldDeferRootTopInset(`${routes.assistant}/onboarding`, "")).toBe(
      true,
    );
    expect(
      shouldDeferRootTopInset(`${routes.assistant}/onboarding/research`, ""),
    ).toBe(true);
  });

  test("suppresses setup routes around onboarding", () => {
    expect(shouldDeferRootTopInset(routes.welcome, "")).toBe(true);
  });

  test("suppresses the onboarding handoff query on the assistant route", () => {
    expect(shouldDeferRootTopInset(routes.assistant, "?onboarding=1")).toBe(
      true,
    );
  });

  test("allows normal app routes", () => {
    expect(shouldDeferRootTopInset(routes.settings.root, "")).toBe(false);
    expect(shouldDeferRootTopInset(routes.assistant, "")).toBe(false);
  });
});
