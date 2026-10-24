/**
 * Tests for the research flow's adopt-vs-managed-hatch decision. The explicit
 * hosting choice must win when present; a missing query string must fall back
 * to the live-session signal so a pre-hatched local assistant is never routed
 * onto the cloud hatch (which gates the flow on a wake that never ends
 * against a local gateway).
 */

import { describe, expect, test } from "bun:test";

import { shouldAdoptExistingAssistant } from "./adopt-existing-assistant";

describe("shouldAdoptExistingAssistant", () => {
  test("platform (non-local) builds always run the cloud hatch", () => {
    for (const hostingParam of [null, "local", "docker", "cadet-cloud"]) {
      expect(
        shouldAdoptExistingAssistant({
          hostingParam,
          localMode: false,
          gatewayAuthSession: false,
        }),
      ).toBe(false);
    }
  });

  test("explicit local/docker hosting adopts the foreground-hatched assistant", () => {
    for (const hostingParam of ["local", "docker"]) {
      expect(
        shouldAdoptExistingAssistant({
          hostingParam,
          localMode: true,
          gatewayAuthSession: false,
        }),
      ).toBe(true);
    }
  });

  test("explicit cadet-cloud hosting runs the cloud hatch even over a live local session", () => {
    // The desktop app can onboard a cloud assistant while still holding a
    // gateway session from a previous local one — the explicit choice wins.
    expect(
      shouldAdoptExistingAssistant({
        hostingParam: "cadet-cloud",
        localMode: true,
        gatewayAuthSession: true,
      }),
    ).toBe(false);
  });

  test("no hosting param with a live local session adopts the connected assistant", () => {
    // A refresh or back-navigation that lost the query string must not strand
    // a pre-hatched local assistant behind the cloud wake gate.
    expect(
      shouldAdoptExistingAssistant({
        hostingParam: null,
        localMode: true,
        gatewayAuthSession: true,
      }),
    ).toBe(true);
  });

  test("no hosting param and no local session runs the cloud hatch", () => {
    // Desktop app connected to a Cadet-Cloud assistant (platform session):
    // the cloud hatch resolves that existing assistant.
    expect(
      shouldAdoptExistingAssistant({
        hostingParam: null,
        localMode: true,
        gatewayAuthSession: false,
      }),
    ).toBe(false);
  });
});
