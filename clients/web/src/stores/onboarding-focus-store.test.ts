import { beforeEach, describe, expect, test } from "bun:test";

import { useOnboardingFocusStore } from "@/stores/onboarding-focus-store";

beforeEach(() => {
  useOnboardingFocusStore.setState({
    focused: false,
    pendingAvatarTraits: null,
  });
});

describe("useOnboardingFocusStore — the handoff staging", () => {
  test("exitFocus preserves staged avatar traits for the handoff applier", () => {
    const traits = { bodyShape: "round", eyeStyle: "dot", color: "green" };
    useOnboardingFocusStore.getState().setPendingAvatarTraits(traits);

    useOnboardingFocusStore.getState().exitFocus();

    expect(useOnboardingFocusStore.getState().pendingAvatarTraits).toEqual(
      traits,
    );
  });
});
