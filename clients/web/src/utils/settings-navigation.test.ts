import { describe, expect, test } from "bun:test";

import {
  SETTINGS_SIDEBAR,
  getSettingsRouteForClientTab,
} from "@/utils/settings-navigation";

describe("getSettingsRouteForClientTab — Debug page", () => {
  test("resolves the debug and developer client tabs to the Debug page", () => {
    expect(getSettingsRouteForClientTab("debug")).toBe(
      "/assistant/settings/debug",
    );
    expect(getSettingsRouteForClientTab("developer")).toBe(
      "/assistant/settings/debug",
    );
  });

  test("routes the archive alias to the Debug Archive tab", () => {
    // The bare Debug route opens General, so archive must carry ?tab=archive to
    // land on the Archive tab.
    expect(getSettingsRouteForClientTab("archive")).toBe(
      "/assistant/settings/debug?tab=archive",
    );
    expect(getSettingsRouteForClientTab("Archive")).toBe(
      "/assistant/settings/debug?tab=archive",
    );
  });

  test("routes the Billing and Usage tabs to the usage page", () => {
    // The usage page is de-tabbed (the billing panels live in the cloud's
    // account surface), so every legacy tab name lands on the bare page.
    expect(getSettingsRouteForClientTab("Billing")).toBe(
      "/assistant/settings/usage",
    );
    expect(getSettingsRouteForClientTab("Billing & Usage")).toBe(
      "/assistant/settings/usage",
    );
    expect(getSettingsRouteForClientTab("Usage")).toBe(
      "/assistant/settings/usage",
    );
  });

  test("resolves the Debug sidebar label to the Debug page without ambiguity", () => {
    expect(getSettingsRouteForClientTab("Debug")).toBe(
      "/assistant/settings/debug",
    );
  });

  test("keeps resolving the legacy Advanced tab name to the Debug page", () => {
    expect(getSettingsRouteForClientTab("Advanced")).toBe(
      "/assistant/settings/debug",
    );
  });

  test("resolves Sounds to its own page, not the Voice page", () => {
    // Sounds used to be a `?tab=sounds` panel on Voice & Sounds; it's a
    // first-class page now, so the bare label must resolve there.
    expect(getSettingsRouteForClientTab("Sounds")).toBe(
      "/assistant/settings/sounds",
    );
  });

  test("routes speech-service lookups to Models & Services", () => {
    // The BYO TTS/STT forms moved off the Voice page to sit with every other
    // provider, so the old "Services" tab name has to follow them.
    expect(getSettingsRouteForClientTab("Services")).toBe(
      "/assistant/settings/ai",
    );
    expect(getSettingsRouteForClientTab("Text-to-Speech")).toBe(
      "/assistant/settings/ai",
    );
  });

  test("keeps resolving the retired Voice & Sounds label to Voice", () => {
    expect(getSettingsRouteForClientTab("Voice & Sounds")).toBe(
      "/assistant/settings/voice",
    );
    expect(getSettingsRouteForClientTab("Voice")).toBe(
      "/assistant/settings/voice",
    );
  });

  test("no two sidebar items share a label", () => {
    // The label is a lookup key in the fallback tier, so a duplicate would make
    // resolution order-dependent.
    const labels = SETTINGS_SIDEBAR.map((item) => item.label.toLowerCase());
    expect(new Set(labels).size).toBe(labels.length);
  });

  test("returns null for an unknown tab name", () => {
    expect(getSettingsRouteForClientTab("not-a-real-tab")).toBeNull();
  });
});
