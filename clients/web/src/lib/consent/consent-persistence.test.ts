/**
 * Tests for the versioned legal-consent persistence layer in
 * `consent-persistence`.
 *
 * Collaborators (`onboarding-store`) are mocked so we exercise the per-user
 * device-key read/write logic in isolation against an in-memory
 * `localStorage`.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import { installMemoryStorage } from "@/utils/memory-storage.test-helper";

installMemoryStorage({ beforeAll, afterAll, beforeEach, afterEach });

const storeState = {
  setTosAccepted: mock(() => {}),
  setPrivacyConsent: mock(() => {}),
  setHasConsentRecord: mock(() => {}),
  setConsentHydrated: mock(() => {}),
};
mock.module("@/domains/onboarding/onboarding-store", () => ({
  useOnboardingStore: { getState: () => storeState },
}));

import {
  TOS_CONSENT_VERSION,
  PRIVACY_CONSENT_VERSION,
  __resetRequiredConsentVersionsForTesting,
  clearConsentForUser,
  persistConsentForUser,
  restoreConsentForUser,
  saveConsent,
} from "@/lib/consent/consent-persistence";

// Unversioned per-user ack keys; the VALUE is the acknowledged version.
const tosAckKey = (userId: string) => `device:consent:tos:${userId}`;
const privacyPolicyAckKey = (userId: string) =>
  `device:consent:privacy_policy:${userId}`;
const aiDataSharingAckKey = (userId: string) =>
  `device:consent:ai_data_sharing:${userId}`;
// Legacy layout: the version was embedded in the KEY over a boolean value.
const legacyVersionedKey = (field: string, version: string, userId: string) =>
  `device:consent:${field}:v${version}:${userId}`;

beforeEach(() => {
  __resetRequiredConsentVersionsForTesting();
  storeState.setTosAccepted.mockReset();
  storeState.setPrivacyConsent.mockReset();
  storeState.setHasConsentRecord.mockReset();
  storeState.setConsentHydrated.mockReset();
});

describe("persistConsentForUser + restoreConsentForUser round-trip", () => {
  test("round-trips the legal ack keys (value = acknowledged version)", () => {
    persistConsentForUser("u1", true, true);
    expect(localStorage.getItem(tosAckKey("u1"))).toBe(TOS_CONSENT_VERSION);
    expect(localStorage.getItem(privacyPolicyAckKey("u1"))).toBe(
      PRIVACY_CONSENT_VERSION,
    );
    expect(localStorage.getItem(aiDataSharingAckKey("u1"))).toBe(
      PRIVACY_CONSENT_VERSION,
    );

    const restored = restoreConsentForUser("u1");
    expect(restored).toEqual({ tos: true, privacy: true });
  });

  test("restore reads false while no ack has been stamped", () => {
    const restored = restoreConsentForUser("u2");
    expect(restored).toEqual({ tos: false, privacy: false });
  });

  test("no-ops without a userId", () => {
    persistConsentForUser(null, true, true);
    expect(localStorage.length).toBe(0);
    expect(restoreConsentForUser(null)).toEqual({ tos: false, privacy: false });
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
    expect(
      localStorage.getItem("device:consent:ai:v2026-06-08:u4"),
    ).toBeNull();
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
      localStorage.getItem(legacyVersionedKey("tos", TOS_CONSENT_VERSION, "u6")),
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

describe("clearConsentForUser", () => {
  test("clears the ack keys, legacy versioned keys, and legacy active keys", () => {
    persistConsentForUser("u8", true, true);
    localStorage.setItem(
      legacyVersionedKey("tos", "2026-01-01", "u8"),
      "true",
    );
    localStorage.setItem("cadet:onboarding:tosAccepted", "true");
    localStorage.setItem("cadet:onboarding:aiDataConsent", "true");
    localStorage.setItem("cadet:onboarding:selectedVersion", "1.2.3");

    clearConsentForUser("u8");

    expect(localStorage.getItem(tosAckKey("u8"))).toBeNull();
    expect(localStorage.getItem(privacyPolicyAckKey("u8"))).toBeNull();
    expect(localStorage.getItem(aiDataSharingAckKey("u8"))).toBeNull();
    expect(localStorage.getItem("cadet:onboarding:tosAccepted")).toBeNull();
    expect(localStorage.getItem("cadet:onboarding:aiDataConsent")).toBeNull();
    expect(localStorage.getItem("cadet:onboarding:selectedVersion")).toBeNull();
    expect(
      localStorage.getItem(legacyVersionedKey("tos", "2026-01-01", "u8")),
    ).toBeNull();
  });

  test("clears the legacy active keys even without a userId", () => {
    localStorage.setItem("cadet:onboarding:tosAccepted", "true");

    clearConsentForUser(null);

    expect(localStorage.getItem("cadet:onboarding:tosAccepted")).toBeNull();
  });
});

describe("saveConsent", () => {
  test("persists the legal ack keys and marks the record + hydration", () => {
    saveConsent({ userId: "u9", tos: true, privacy: true });

    expect(localStorage.getItem(tosAckKey("u9"))).toBe(TOS_CONSENT_VERSION);
    expect(localStorage.getItem(privacyPolicyAckKey("u9"))).toBe(
      PRIVACY_CONSENT_VERSION,
    );
    expect(localStorage.getItem(aiDataSharingAckKey("u9"))).toBe(
      PRIVACY_CONSENT_VERSION,
    );
    expect(storeState.setTosAccepted).toHaveBeenCalledWith(true);
    expect(storeState.setPrivacyConsent).toHaveBeenCalledWith(true);
    expect(storeState.setHasConsentRecord).toHaveBeenCalledWith(true);
    expect(storeState.setConsentHydrated).toHaveBeenCalledWith(true);
  });

  test("a refused privacy box removes its ack keys", () => {
    persistConsentForUser("u10", true, true);
    storeState.setTosAccepted.mockReset();
    storeState.setPrivacyConsent.mockReset();
    storeState.setHasConsentRecord.mockReset();
    storeState.setConsentHydrated.mockReset();

    saveConsent({ userId: "u10", tos: true, privacy: false });

    expect(localStorage.getItem(tosAckKey("u10"))).toBe(TOS_CONSENT_VERSION);
    expect(localStorage.getItem(privacyPolicyAckKey("u10"))).toBeNull();
    expect(localStorage.getItem(aiDataSharingAckKey("u10"))).toBeNull();
    expect(storeState.setPrivacyConsent).toHaveBeenCalledWith(false);
  });
});
