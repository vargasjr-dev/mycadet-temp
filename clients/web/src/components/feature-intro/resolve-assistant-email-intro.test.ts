import { describe, expect, test } from "bun:test";

import { FEATURE_INTRO_LAUNCHED_AT } from "@/hooks/use-feature-intro-seen";

import {
  resolveAssistantEmailIntro,
  shouldOfferAssistantEmailIntro,
  type AssistantEmailIntroInputs,
} from "./resolve-assistant-email-intro";

const LAUNCH = Date.parse(FEATURE_INTRO_LAUNCHED_AT["assistant-email"]);
const DAY_MS = 24 * 60 * 60 * 1000;
/** An assistant from the week before the intro shipped: an existing user. */
const EXISTING = new Date(LAUNCH - 7 * DAY_MS).toISOString();
/** One made the day after: a new user, who never sees it. */
const NEW = new Date(LAUNCH + DAY_MS).toISOString();

const READY: AssistantEmailIntroInputs = {
  seen: false,
  onboardingBusy: false,
  assistantCreatedAt: EXISTING,
  status: "loading",
};

describe("resolveAssistantEmailIntro", () => {
  test("no address yet keeps the intro withheld (nothing to announce)", () => {
    expect(resolveAssistantEmailIntro(READY)).toBeNull();
  });

  test("an assistant with no address gets the way into setup", () => {
    expect(resolveAssistantEmailIntro({ ...READY, status: "setup" })).toBe(
      "open",
    );
  });

  test("an assistant with an address is not introduced to it", () => {
    expect(
      resolveAssistantEmailIntro({ ...READY, status: "ready" }),
    ).toBeNull();
  });

  test("nothing shows while the reads that decide are pending", () => {
    expect(
      resolveAssistantEmailIntro({ ...READY, status: "loading" }),
    ).toBeNull();
  });

  test("off the cloud, or once seen, nothing shows", () => {
    expect(
      resolveAssistantEmailIntro({ ...READY, status: "unavailable" }),
    ).toBeNull();
    expect(resolveAssistantEmailIntro({ ...READY, seen: true })).toBeNull();
  });

  test("the onboarding takeover is not interrupted", () => {
    expect(
      resolveAssistantEmailIntro({ ...READY, onboardingBusy: true }),
    ).toBeNull();
  });

  test("a user who joined after the launch is not introduced to it", () => {
    expect(
      resolveAssistantEmailIntro({ ...READY, assistantCreatedAt: NEW }),
    ).toBeNull();
    expect(
      resolveAssistantEmailIntro({
        ...READY,
        assistantCreatedAt: NEW,
        status: "setup",
      }),
    ).toBeNull();
  });

  test("nothing shows until the assistant's age is known", () => {
    expect(
      resolveAssistantEmailIntro({ ...READY, assistantCreatedAt: null }),
    ).toBeNull();
  });
});

describe("shouldOfferAssistantEmailIntro", () => {
  test("an off-platform assistant is never owed the intro", () => {
    for (const cloud of [
      "local",
      "docker",
      "apple-container",
      "baseten",
      "custom",
    ] as const) {
      expect(
        shouldOfferAssistantEmailIntro(cloud, "2020-01-01T00:00:00.000Z"),
      ).toBe(false);
    }
  });

  test("a platform assistant predating the intro is owed it", () => {
    expect(
      shouldOfferAssistantEmailIntro("cloud", "2020-01-01T00:00:00.000Z"),
    ).toBe(true);
  });

  test("a platform assistant newer than the intro is not", () => {
    expect(
      shouldOfferAssistantEmailIntro("cloud", "2099-01-01T00:00:00.000Z"),
    ).toBe(false);
  });

  test("an unknown creation instant is not owed one — the resolver's own ruling", () => {
    expect(shouldOfferAssistantEmailIntro("cloud", null)).toBe(false);
    expect(shouldOfferAssistantEmailIntro("cloud", undefined)).toBe(false);
  });
});
