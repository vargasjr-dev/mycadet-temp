import { describe, expect, test } from "bun:test";

import { shouldDeferRootTopInset } from "@/utils/root-top-inset";
import { routes } from "@/utils/routes";

describe("shouldDeferRootTopInset", () => {
  test("suppresses onboarding funnel routes", () => {
    for (const pathname of [
      routes.onboarding.hosting,
      routes.onboarding.apiKey,
      routes.onboarding.hatching,
      `${routes.assistant}/onboarding`,
    ]) {
      expect(shouldDeferRootTopInset(pathname, "")).toBe(true);
    }
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
