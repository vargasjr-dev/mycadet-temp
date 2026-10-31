import { describe, expect, test } from "bun:test";

import {
  ONBOARDED_HATCH_AGE_MS,
  isAssistantOnboarded,
  isHatchedOnboarded,
  isSelectedAssistantOnboarded,
  userHasOnboardedAssistant,
} from "./onboarded-assistant";
import { markAssistantOnboarded } from "./onboarded-assistant-record";

const NOW = Date.now();

describe("isHatchedOnboarded", () => {
  test("is true at the hatch-age threshold", () => {
    const WEEK_OLD = new Date(NOW - ONBOARDED_HATCH_AGE_MS).toISOString();
    expect(isHatchedOnboarded(WEEK_OLD, NOW)).toBe(true);
  });

  test("is false for a fresh hatch", () => {
    const FRESH = new Date(NOW).toISOString();
    expect(isHatchedOnboarded(FRESH, NOW)).toBe(false);
  });

  test("ignores missing or unparseable hatch dates", () => {
    expect(isHatchedOnboarded(undefined, NOW)).toBe(false);
    expect(isHatchedOnboarded("", NOW)).toBe(false);
    expect(isHatchedOnboarded("not-a-date", NOW)).toBe(false);
  });
});

describe("userHasOnboardedAssistant", () => {
  test("is true when the assistant is past the hatch-age threshold", () => {
    expect(
      userHasOnboardedAssistant(
        {
          assistantId: "a",
          hatchedAt: new Date(NOW - ONBOARDED_HATCH_AGE_MS).toISOString(),
        },
        NOW,
      ),
    ).toBe(true);
  });

  test("is false when the assistant is fresh or undated", () => {
    expect(
      userHasOnboardedAssistant(
        {
          assistantId: "a",
          hatchedAt: new Date(NOW - 3 * 24 * 60 * 60 * 1000).toISOString(),
        },
        NOW,
      ),
    ).toBe(false);
    expect(userHasOnboardedAssistant(null, NOW)).toBe(false);
  });
});

const FRESH = new Date(NOW).toISOString();
const WEEK_OLD = new Date(NOW - ONBOARDED_HATCH_AGE_MS).toISOString();

describe("isAssistantOnboarded", () => {
  test("a lockfile-stamped assistant is onboarded however fresh its hatch", () => {
    expect(
      isAssistantOnboarded(
        { assistantId: "a", hatchedAt: FRESH, onboardedAt: FRESH },
        NOW,
      ),
    ).toBe(true);
  });

  // The device half is read live, so a completion answers immediately rather
  // than waiting for the assistant list to be rebuilt.
  test("the device record answers for an assistant the lockfile has not stamped", () => {
    expect(
      isAssistantOnboarded({ assistantId: "a", hatchedAt: FRESH }, NOW),
    ).toBe(false);

    markAssistantOnboarded("a", FRESH);

    expect(
      isAssistantOnboarded({ assistantId: "a", hatchedAt: FRESH }, NOW),
    ).toBe(true);
    expect(
      isAssistantOnboarded({ assistantId: "b", hatchedAt: FRESH }, NOW),
    ).toBe(false);
  });

  test("falls back to hatch age when unstamped", () => {
    // Distinct ids: the device record from the block above must not leak in.
    expect(
      isAssistantOnboarded({ assistantId: "hatch-old", hatchedAt: WEEK_OLD }, NOW),
    ).toBe(true);
    expect(
      isAssistantOnboarded({ assistantId: "hatch-fresh", hatchedAt: FRESH }, NOW),
    ).toBe(false);
    expect(isAssistantOnboarded({ assistantId: "hatch-none" }, NOW)).toBe(false);
  });
});

describe("isSelectedAssistantOnboarded", () => {
  test("answers for the served assistant's own stamp", () => {
    expect(
      isSelectedAssistantOnboarded(
        { assistantId: "old", hatchedAt: WEEK_OLD },
        NOW,
      ),
    ).toBe(true);
    expect(
      isSelectedAssistantOnboarded(
        { assistantId: "stamped", hatchedAt: FRESH, onboardedAt: FRESH },
        NOW,
      ),
    ).toBe(true);
    expect(
      isSelectedAssistantOnboarded(
        { assistantId: "new", hatchedAt: FRESH },
        NOW,
      ),
    ).toBe(false);
  });

  test("is false when nothing is served", () => {
    expect(isSelectedAssistantOnboarded(null, NOW)).toBe(false);
  });
});
