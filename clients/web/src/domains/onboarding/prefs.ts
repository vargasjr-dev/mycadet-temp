/**
 * Onboarding preference public API.
 *
 * Consent preferences are owned by `useOnboardingStore` — the legal flags
 * (`tosAccepted`, `privacyConsent`) are booleans populated by an explicit
 * acceptance or a per-user device restore. This file exposes the hook +
 * non-React shim around the store, plus the non-store helpers for the
 * onboarding-only keys that don't fit the boolean store shape
 * (`onboarding.selectedVersion`, `onboarding.lastUserId`).
 */
import { useCallback } from "react";

import {
  getLocalSetting,
  removeLocalSetting,
  setLocalSetting,
} from "@/utils/local-settings";
import { useOnboardingStore } from "@/domains/onboarding/onboarding-store";

// ---------------------------------------------------------------------------
// Storage keys (non-boolean — boolean keys live in onboarding-store.ts)
// ---------------------------------------------------------------------------

/**
 * Onboarding-only, nonprod-only: pinned release version for the hatch.
 * Written by the privacy screen's dev-tools version picker, read by the
 * hatching screen and forwarded to `hatchAssistant({ version })`. Empty
 * string / absent means "latest" (the normal managed default).
 */
const KEY_SELECTED_VERSION = "cadet:onboarding:selectedVersion";

// ---------------------------------------------------------------------------
// Public hooks — thin wrappers around the Zustand store
// ---------------------------------------------------------------------------

/** Whether the user accepted Terms of Service during onboarding. Defaults to `false`. */
export function useTosAccepted(): [boolean, (next: boolean) => void] {
  const value = useOnboardingStore.use.tosAccepted();
  const setter = useCallback((next: boolean) => {
    useOnboardingStore.getState().setTosAccepted(next);
  }, []);
  return [value, setter];
}

/**
 * Whether the user accepted the Privacy Policy and AI Data Sharing Policy
 * (the second onboarding checkbox). Defaults to `false`. Tracked separately
 * from `useTosAccepted` so the consent surface remains specific (Apple
 * Guideline 5.1.2(i)).
 */
export function usePrivacyConsent(): [boolean, (next: boolean) => void] {
  const value = useOnboardingStore.use.privacyConsent();
  const setter = useCallback((next: boolean) => {
    useOnboardingStore.getState().setPrivacyConsent(next);
  }, []);
  return [value, setter];
}

/**
 * Whether the cloud has any consent record for this user, set on session
 * sync by the auth store (device acks count as evidence).
 *
 * Consent surfaces must key first-time framing off THIS flag, not off
 * `useTosAccepted()`/`usePrivacyConsent()`: those two carry version currency,
 * so both read `false` for a never-consented user AND for an established user
 * whose acceptances went stale when both required versions were bumped.
 */
export function useHasConsentRecord(): boolean {
  return useOnboardingStore.use.hasConsentRecord();
}

// ---------------------------------------------------------------------------
// Non-hook readers (for gates/guards outside React render)
// ---------------------------------------------------------------------------

/**
 * SSR-safe, non-hook read of the TOS-accepted flag. Used by
 * `/onboarding/hatching` to refuse to provision an assistant if the user
 * navigated directly to that URL without ever seeing the privacy screen.
 */
export function readTosAccepted(): boolean {
  return useOnboardingStore.getState().tosAccepted;
}

/**
 * SSR-safe, non-hook read of the Privacy Policy + AI Data Sharing consent
 * flag. Used alongside `readTosAccepted()` by the hatching gate so a user who
 * somehow has only one of the two acknowledgments persisted (storage
 * race, partial restore from a sync mechanism) is bounced back through
 * the privacy screen rather than allowed to provision an assistant
 * without explicit privacy consent.
 */
export function readPrivacyConsent(): boolean {
  return useOnboardingStore.getState().privacyConsent;
}

/**
 * SSR-safe, non-hook read of whether the cloud has any consent record for this
 * user. Used by the navigation guard to tell a never-consented user (no
 * record — consent is trivially current) from a user whose accepted versions
 * went stale (record present — a re-review is owed). Mirrors
 * `useHasConsentRecord` for gates outside React render.
 */
export function readHasConsentRecord(): boolean {
  return useOnboardingStore.getState().hasConsentRecord;
}

/**
 * SSR-safe, non-hook read of whether the consent flags reflect a completed
 * session sync (or an explicit user acceptance). Used by the navigation guard
 * to defer consent-based redirects until the flags are trustworthy — the
 * flags boot `false` and only reflect reality once hydration lands.
 */
export function readConsentHydrated(): boolean {
  return useOnboardingStore.getState().consentHydrated;
}

/**
 * Read the pinned release version the user picked on the privacy screen's
 * nonprod version selector. Empty string means "latest" / no pin. SSR-safe
 * and tolerant of disabled storage.
 */
export function readSelectedVersion(): string {
  if (typeof window === "undefined") {
    return "";
  }
  try {
    return getLocalSetting(KEY_SELECTED_VERSION, "");
  } catch {
    return "";
  }
}

/**
 * Persist (or clear) the pinned release version. An empty string clears
 * the key so the next hatch uses the cloud "latest" default.
 */
export function writeSelectedVersion(version: string): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    if (version === "") {
      removeLocalSetting(KEY_SELECTED_VERSION);
    } else {
      setLocalSetting(KEY_SELECTED_VERSION, version);
    }
  } catch {
    // Storage unavailable — the hatch will fall back to "latest", which is
    // the right default.
  }
}
