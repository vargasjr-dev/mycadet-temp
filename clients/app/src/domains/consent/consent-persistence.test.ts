import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  __resetRequiredConsentVersionsForTesting,
  PRIVACY_CONSENT_VERSION,
  TOS_CONSENT_VERSION,
  clearConsentForUser,
  persistConsentForUser,
  readConsentCurrency,
  restoreConsentForUser,
  saveConsent,
} from "./consent-persistence";

const USER = "user-1";
const OTHER = "user-2";

function ack(field: string, userId: string, version: string): void {
  localStorage.setItem(`device:consent:${field}:${userId}`, version);
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  __resetRequiredConsentVersionsForTesting();
  localStorage.clear();
});

describe("the shell's consent persistence", () => {
  test("a fresh user reads nothing current and no record", () => {
    expect(readConsentCurrency(USER)).toEqual({
      tos: false,
      privacy: false,
      hasConsentRecord: false,
    });
  });

  test("an ack at the required version is current; an older one is stale", () => {
    ack("tos", USER, TOS_CONSENT_VERSION);
    expect(restoreConsentForUser(USER).tos).toBe(true);

    ack("tos", USER, "2026-01-01");
    expect(restoreConsentForUser(USER).tos).toBe(false);
  });

  test("privacy is current only when BOTH artifact acks are current", () => {
    ack("privacy_policy", USER, PRIVACY_CONSENT_VERSION);
    expect(restoreConsentForUser(USER).privacy).toBe(false);
    ack("ai_data_sharing", USER, PRIVACY_CONSENT_VERSION);
    expect(restoreConsentForUser(USER).privacy).toBe(true);
  });

  test("acks are per-user", () => {
    ack("tos", USER, TOS_CONSENT_VERSION);
    expect(restoreConsentForUser(OTHER).tos).toBe(false);
    expect(restoreConsentForUser(USER).tos).toBe(true);
  });

  test("saveConsent writes the required versions, currency round-trips", () => {
    saveConsent({ userId: USER, tos: true, privacy: true });
    expect(localStorage.getItem(`device:consent:tos:${USER}`)).toBe(
      TOS_CONSENT_VERSION,
    );
    expect(readConsentCurrency(USER)).toEqual({
      tos: true,
      privacy: true,
      hasConsentRecord: true,
    });
  });

  test("a partial save reads as a re-review, not a first consent", () => {
    saveConsent({ userId: USER, tos: true, privacy: false });
    const currency = readConsentCurrency(USER);
    expect(currency.hasConsentRecord).toBe(true);
    expect(currency.privacy).toBe(false);
  });

  test("a garbled ack version reads as absent", () => {
    localStorage.setItem(`device:consent:tos:${USER}`, "not-a-date");
    expect(restoreConsentForUser(USER).tos).toBe(false);
  });

  test("clearConsentForUser removes the user's acks but not other users'", () => {
    saveConsent({ userId: USER, tos: true, privacy: true });
    ack("tos", OTHER, TOS_CONSENT_VERSION);

    clearConsentForUser(USER);

    expect(readConsentCurrency(USER).hasConsentRecord).toBe(false);
    expect(restoreConsentForUser(OTHER).tos).toBe(true);
  });

  test("a required-version bump turns yesterday's consent stale", () => {
    saveConsent({ userId: USER, tos: true, privacy: true });
    // Simulate the next release: the required ToS version bumps.
    ack("tos", USER, TOS_CONSENT_VERSION);
    ack("privacy_policy", USER, PRIVACY_CONSENT_VERSION);
    ack("ai_data_sharing", USER, PRIVACY_CONSENT_VERSION);
    const before = readConsentCurrency(USER);
    expect(before.tos).toBe(true);

    // The bump itself is a build constant; simulate by rewriting the ack at
    // an older version and requiring the current one.
    ack("tos", USER, "2026-06-07");
    expect(readConsentCurrency(USER).tos).toBe(false);
    expect(readConsentCurrency(USER).hasConsentRecord).toBe(true);
  });
});
