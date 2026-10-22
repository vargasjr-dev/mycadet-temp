/**
 * Tests for the read/migration half of the versioned legal-consent
 * persistence in `consent-persistence`.
 *
 * Web keeps the READ half only — the shell's `/account/consent` screen (the
 * app bundle's copy of this contract) is the sole writer, and its write-path
 * coverage lives in `clients/app`. These tests seed the device keys directly
 * and exercise the per-user read + legacy-migration logic in isolation
 * against an in-memory `localStorage`.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import { installMemoryStorage } from "@/utils/memory-storage.test-helper";

installMemoryStorage({ beforeAll, afterAll, beforeEach, afterEach });

import {
  TOS_CONSENT_VERSION,
  PRIVACY_CONSENT_VERSION,
  __resetRequiredConsentVersionsForTesting,
  restoreConsentForUser,
} from "@/lib/consent/consent-persistence";

// Unversioned per-user ack keys; the VALUE is the acknowledged version.
const tosAckKey = (userId: string) => `device:consent:tos:${userId}`;
const privacyPolicyAckKey = (userId: string) =>
  `device:consent:privacy_policy:${userId}`;
// Legacy layout: the version was embedded in the KEY over a boolean value.
const legacyVersionedKey = (field: string, version: string, userId: string) =>
  `device:consent:${field}:v${version}:${userId}`;

beforeEach(() => {
  __resetRequiredConsentVersionsForTesting();
});

describe("restoreConsentForUser", () => {
  test("reads false while no ack has been stamped", () => {
    const restored = restoreConsentForUser("u2");
    expect(restored).toEqual({ tos: false, privacy: false });
  });

  test("no-ops without a userId", () => {
    expect(restoreConsentForUser(null)).toEqual({ tos: false, privacy: false });
  });

  test("reads current acks on both axes", () => {
    localStorage.setItem(tosAckKey("u1"), TOS_CONSENT_VERSION);
    localStorage.setItem(privacyPolicyAckKey("u1"), PRIVACY_CONSENT_VERSION);
    localStorage.setItem(
      `device:consent:ai_data_sharing:u1`,
      PRIVACY_CONSENT_VERSION,
    );

    const restored = restoreConsentForUser("u1");
    expect(restored).toEqual({ tos: true, privacy: true });
  });

  test("privacy needs BOTH artifacts current — a single stale artifact is stale", () => {
    // Stamp privacy_policy at the current version but ai_data_sharing at an
    // older one (via a legacy versioned key that migrates verbatim).
    localStorage.setItem(tosAckKey("u3"), TOS_CONSENT_VERSION);
    localStorage.setItem(privacyPolicyAckKey("u3"), PRIVACY_CONSENT_VERSION);
    localStorage.setItem(
      legacyVersionedKey("privacy", "2026-06-08", "u3"),
      "true",
    );

    const restored = restoreConsentForUser("u3");
    expect(restored.tos).toBe(true);
    expect(restored.privacy).toBe(false);
  });

  test("cleans up the legacy 'ai' key without satisfying the current privacy version", () => {
    localStorage.setItem("device:consent:ai:v2026-06-08:u4", "true");

    const restored = restoreConsentForUser("u4");

    // The legacy key predates the current privacy version: never promoted.
    expect(restored.privacy).toBe(false);
    expect(localStorage.getItem("device:consent:ai:v2026-06-08:u4")).toBeNull();
  });

  test("migrates legacy unversioned ToS but forces privacy re-review", () => {
    localStorage.setItem("cadet:onboarding:tosAccepted", "true");
    localStorage.setItem("cadet:onboarding:aiDataConsent", "true");

    const restored = restoreConsentForUser("u5");

    expect(restored.tos).toBe(true);
    // The unversioned legacy privacy key predates the current privacy version,
    // so promoting it would stamp stale consent as current — force re-review.
    expect(restored.privacy).toBe(false);
    expect(localStorage.getItem(tosAckKey("u5"))).toBe(TOS_CONSENT_VERSION);
  });

  test("promotes legacy versioned ack keys to unversioned keys (version becomes the value)", () => {
    localStorage.setItem(
      legacyVersionedKey("tos", TOS_CONSENT_VERSION, "u6"),
      "true",
    );
    localStorage.setItem(
      legacyVersionedKey("privacy", PRIVACY_CONSENT_VERSION, "u6"),
      "true",
    );

    const restored = restoreConsentForUser("u6");

    expect(restored).toEqual({ tos: true, privacy: true });
    expect(localStorage.getItem(tosAckKey("u6"))).toBe(TOS_CONSENT_VERSION);
    expect(localStorage.getItem(privacyPolicyAckKey("u6"))).toBe(
      PRIVACY_CONSENT_VERSION,
    );
    // Every legacy key for the field is removed after the migration.
    expect(
      localStorage.getItem(
        legacyVersionedKey("tos", TOS_CONSENT_VERSION, "u6"),
      ),
    ).toBeNull();
    expect(
      localStorage.getItem(
        legacyVersionedKey("privacy", PRIVACY_CONSENT_VERSION, "u6"),
      ),
    ).toBeNull();
  });

  test("migration promotes the attested version verbatim — an old version reads stale, not current", () => {
    localStorage.setItem(legacyVersionedKey("tos", "2026-01-01", "u7"), "true");

    const restored = restoreConsentForUser("u7");

    expect(restored.tos).toBe(false);
    expect(localStorage.getItem(tosAckKey("u7"))).toBe("2026-01-01");
  });
});
