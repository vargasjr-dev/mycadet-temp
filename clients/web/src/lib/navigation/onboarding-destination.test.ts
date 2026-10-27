import { describe, expect, test } from "bun:test";

import {
  NEW_ASSISTANT_PARAM,
  isNewAssistantFunnel,
  onboardingDestinationAfterConsent,
} from "@/lib/navigation/onboarding-destination";
import { routes } from "@/utils/routes";

describe("onboardingDestinationAfterConsent", () => {
  test("platform/Cadet-Cloud routes straight to the research flow", () => {
    expect(
      onboardingDestinationAfterConsent({
        isLocalHatch: false,
      }),
    ).toBe(routes.onboarding.research);
  });

  test("local hosting routes to hatching first (foreground local hatch → research)", () => {
    expect(onboardingDestinationAfterConsent({ isLocalHatch: true })).toBe(
      routes.onboarding.hatching,
    );
  });

  test("an onboarded selected assistant skips research on every build", () => {
    expect(
      onboardingDestinationAfterConsent({
        isLocalHatch: false,
        selectedAssistantOnboarded: true,
      }),
    ).toBe(routes.assistant);
  });

  test("a new-assistant walk hatches even when the selected assistant is onboarded", () => {
    expect(
      onboardingDestinationAfterConsent({
        isLocalHatch: false,
        selectedAssistantOnboarded: true,
        newAssistant: true,
      }),
    ).toBe(routes.onboarding.research);
    expect(
      onboardingDestinationAfterConsent({
        isLocalHatch: true,
        selectedAssistantOnboarded: true,
        newAssistant: true,
      }),
    ).toBe(routes.onboarding.hatching);
  });

  test("a local hatch outranks the onboarded shortcut without the marker", () => {
    expect(
      onboardingDestinationAfterConsent({
        isLocalHatch: true,
        selectedAssistantOnboarded: true,
      }),
    ).toBe(routes.onboarding.hatching);
  });
});

describe("isNewAssistantFunnel", () => {
  test("true only when the marker is set to 1", () => {
    expect(
      isNewAssistantFunnel(new URLSearchParams(`${NEW_ASSISTANT_PARAM}=1`)),
    ).toBe(true);
    expect(isNewAssistantFunnel(new URLSearchParams())).toBe(false);
    expect(
      isNewAssistantFunnel(new URLSearchParams(`${NEW_ASSISTANT_PARAM}=0`)),
    ).toBe(false);
  });
});
