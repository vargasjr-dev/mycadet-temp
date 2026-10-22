/**
 * Versioned, per-user consent persistence.
 *
 * Consent acknowledgments live in per-user device keys
 * (`device:consent:{tos,privacy_policy,ai_data_sharing}:<userId>`) whose
 * VALUE is the required version the user last confirmed under (a zero-padded
 * ISO date). The `device:` prefix survives logout; the userId makes them
 * per-user. Currency is `storedVersion >= requiredVersion`, where the
 * required versions are the frozen build constants — so a client-side version
 * bump owes a re-review on the next release. The consent axes version
 * independently — ToS, and the privacy checkbox (privacy policy + AI data
 * sharing, each artifact with its own ack) — so any one can be re-reviewed
 * without forcing the others.
 *
 * Web keeps the READ half only — the shell's `/account/consent` screen (the
 * app bundle's copy of this contract) is the sole writer, and these reads see
 * its keys same-origin:
 *
 * - `restoreConsentForUser` — read device keys, return {tos, privacy}
 *
 * (The share-analytics/diagnostics toggles and their server sync were torn
 * out with the telemetry subsystem; only legal consent persists here.)
 */
import {
  getLocalSetting,
  setLocalSetting,
  removeLocalSetting,
  getLocalBool,
} from "@/utils/local-settings";

// Frozen build constants. Review-terms displays change notes keyed off them.
// Zero-padded ISO dates (YYYY-MM-DD): currency is a monotonic comparison
// (`>=`), which requires a lexicographically sortable, chronological format.
export const TOS_CONSENT_VERSION = "2026-06-08";
export const PRIVACY_CONSENT_VERSION = "2026-06-22";

// The privacy version that the legacy "ai"-named device key was last written
// under, before that field was folded into "privacy". Frozen as a literal (not
// PRIVACY_CONSENT_VERSION) so it keeps pointing at the real legacy key after
// the privacy version is bumped — letting us recognize and clean up that stale
// key rather than treating it as current consent.
const LEGACY_AI_PRIVACY_CONSENT_VERSION = "2026-06-08";

// ---------------------------------------------------------------------------
// Required versions
// ---------------------------------------------------------------------------

interface RequiredConsentVersions {
  tos: string;
  privacyPolicy: string;
  aiDataSharing: string;
}

const FALLBACK_REQUIRED_VERSIONS: RequiredConsentVersions = {
  tos: TOS_CONSENT_VERSION,
  privacyPolicy: PRIVACY_CONSENT_VERSION,
  aiDataSharing: PRIVACY_CONSENT_VERSION,
};

let requiredVersions: RequiredConsentVersions = FALLBACK_REQUIRED_VERSIONS;

/** Test-only: restore the constants-fallback required versions. */
export function __resetRequiredConsentVersionsForTesting(): void {
  requiredVersions = FALLBACK_REQUIRED_VERSIONS;
}

// ---------------------------------------------------------------------------
// Device ack keys
// ---------------------------------------------------------------------------

// The device-acknowledged axes. The privacy CHECKBOX covers two artifacts
// (privacy policy + AI data sharing) whose required versions bump
// independently, so each artifact keeps its own ack — a single collapsed
// version would attest an artifact bump the user never saw.
type DeviceAckField = "tos" | "privacy_policy" | "ai_data_sharing";

function consentAckKey(field: DeviceAckField, userId: string): string {
  return `device:consent:${field}:${userId}`;
}

/** The required version a device ack for `field` must meet to be current. */
function requiredAckVersion(field: DeviceAckField): string {
  switch (field) {
    case "tos":
      return requiredVersions.tos;
    case "privacy_policy":
      return requiredVersions.privacyPolicy;
    case "ai_data_sharing":
      return requiredVersions.aiDataSharing;
  }
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The acknowledged version stored for `field`, or `""` when absent/garbled. */
function readAckVersion(field: DeviceAckField, userId: string): string {
  const value = getLocalSetting(consentAckKey(field, userId), "");
  return ISO_DATE_RE.test(value) ? value : "";
}

function isAckCurrent(field: DeviceAckField, userId: string): boolean {
  return versionIsCurrent(
    readAckVersion(field, userId),
    requiredAckVersion(field),
  );
}

// The previous release stored privacy consent under a field named "ai" (now
// folded into "privacy"), written under LEGACY_AI_PRIVACY_CONSENT_VERSION.
function legacyPrivacyConsentKey(userId: string): string {
  return `device:consent:ai:v${LEGACY_AI_PRIVACY_CONSENT_VERSION}:${userId}`;
}

/**
 * One-time migration of the legacy ack layout, which embedded the version in
 * the KEY (`device:consent:<field>:v<VERSION>:<userId>`, boolean value).
 * When `promote` is set and no unversioned ack exists yet, the newest
 * affirmative legacy key's version becomes the unversioned key's value — the
 * legacy key attests exactly the version it was stamped under, so currency
 * against a later required version is decided by the comparison, never
 * assumed. Every legacy key for the field is then removed.
 */
function migrateLegacyVersionedAcks(
  legacyField: "tos" | "privacy",
  userId: string,
  promoteTo: DeviceAckField[],
): void {
  const prefix = `device:consent:${legacyField}:v`;
  const suffix = `:${userId}`;
  const legacyKeys: string[] = [];
  let newestAcked = "";
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(prefix) || !key.endsWith(suffix)) {
      continue;
    }
    const version = key.slice(prefix.length, key.length - suffix.length);
    // The version segment is always an ISO date; anything else is not a
    // legacy ack key (e.g. an unversioned key whose userId starts with "v").
    if (!ISO_DATE_RE.test(version)) {
      continue;
    }
    legacyKeys.push(key);
    if (getLocalBool(key, false) && version > newestAcked) {
      newestAcked = version;
    }
  }
  if (newestAcked) {
    for (const target of promoteTo) {
      if (!readAckVersion(target, userId)) {
        setLocalSetting(consentAckKey(target, userId), newestAcked);
      }
    }
  }
  for (const key of legacyKeys) {
    removeLocalSetting(key);
  }
}

export function restoreConsentForUser(userId: string | null): {
  tos: boolean;
  privacy: boolean;
} {
  if (typeof window === "undefined" || !userId) {
    return { tos: false, privacy: false };
  }
  try {
    migrateLegacyVersionedAcks("tos", userId, ["tos"]);
    // A legacy privacy ack attested BOTH artifacts at its stamped version.
    migrateLegacyVersionedAcks("privacy", userId, [
      "privacy_policy",
      "ai_data_sharing",
    ]);

    // The legacy "ai"-named key was written under the previous privacy version,
    // so it cannot attest to the current one. Never promote it — that would
    // stamp stale consent as current. Clean it up if present so it doesn't
    // linger, and leave privacy un-set so the user re-reviews the updated
    // privacy checkbox.
    if (getLocalBool(legacyPrivacyConsentKey(userId), false)) {
      removeLocalSetting(legacyPrivacyConsentKey(userId));
    }

    const tos = isAckCurrent("tos", userId);
    const privacy =
      isAckCurrent("privacy_policy", userId) &&
      isAckCurrent("ai_data_sharing", userId);

    if (tos || privacy) {
      return { tos, privacy };
    }

    // One-time migration: users who accepted before the per-user device
    // key change still have consent in the legacy cadet: active keys.
    // Promote ToS at the frozen constant — the version the legacy acceptance
    // actually attests — so a later required-version bump correctly reads it
    // stale instead of assuming currency. The legacy privacy key is
    // unversioned and predates the current privacy version, so promoting it
    // would stamp stale consent as current without showing the updated
    // privacy checkbox. Force privacy through re-review instead.
    const legacyTos = getLocalBool("cadet:onboarding:tosAccepted", false);
    const legacyPrivacy = getLocalBool("cadet:onboarding:aiDataConsent", false);
    if (legacyTos || legacyPrivacy) {
      if (legacyTos) {
        setLocalSetting(consentAckKey("tos", userId), TOS_CONSENT_VERSION);
      }
      return {
        tos: legacyTos && isAckCurrent("tos", userId),
        privacy: false,
      };
    }

    return { tos: false, privacy: false };
  } catch {
    return { tos: false, privacy: false };
  }
}

// ---------------------------------------------------------------------------
// Version currency
// ---------------------------------------------------------------------------

/**
 * Whether a recorded `accepted` version satisfies the `required` version.
 * Monotonic (`>=`): a version at or newer than the requirement is current, so
 * a lagging requirement never treats a newer acceptance as stale. `""` (never
 * accepted) sorts below any real version and stays stale. Relies on the
 * ISO-date version format (see the version constants above).
 */
function versionIsCurrent(accepted: string, required: string): boolean {
  return accepted >= required;
}
