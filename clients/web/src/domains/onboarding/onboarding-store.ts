/**
 * Zustand store for onboarding boolean preferences.
 *
 * **In-memory-only fields** (`tosAccepted`, `privacyConsent`) start `false`
 * and are populated by an explicit consent-screen acceptance (`writeConsent`
 * in `consent-persistence.ts`) or restored from per-user device snapshots
 * (`restoreConsentForUser`, called from the auth store once the user id is
 * known). `consentHydrated` (also in-memory-only) records that such a
 * populate has landed, so route guards can distinguish "not yet loaded" from
 * a genuine `false`.
 *
 * Reference: {@link https://zustand.docs.pmnd.rs/}
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";

// ---------------------------------------------------------------------------
// State + Actions
// ---------------------------------------------------------------------------

export interface OnboardingState {
  tosAccepted: boolean;
  privacyConsent: boolean;
  /**
   * Whether the user has any consent record on this device — an explicit
   * acceptance is the only writer now that the server consent sync is gone.
   *
   * Distinct from the legal flags: `tosAccepted`/`privacyConsent` carry
   * VERSION CURRENCY, so both go `false` whenever both required versions are
   * bumped. Only this flag separates "never consented" from "consented, now
   * stale" — consent surfaces must key first-time framing off it, never off
   * the two currency flags. In-memory only.
   */
  hasConsentRecord: boolean;
  /**
   * Whether the consent flags above reflect a restore or an explicit user
   * acceptance rather than their unhydrated boot defaults.
   */
  consentHydrated: boolean;
}

export interface OnboardingActions {
  setTosAccepted: (value: boolean) => void;
  setPrivacyConsent: (value: boolean) => void;
  setHasConsentRecord: (value: boolean) => void;
  setConsentHydrated: (value: boolean) => void;
}

export type OnboardingStore = OnboardingState & OnboardingActions;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const useOnboardingStoreBase = create<OnboardingStore>()((set) => ({
  tosAccepted: false,
  privacyConsent: false,
  hasConsentRecord: false,
  consentHydrated: false,
  setTosAccepted: (value) => {
    set({ tosAccepted: value });
  },
  setPrivacyConsent: (value) => {
    set({ privacyConsent: value });
  },
  setHasConsentRecord: (value) => {
    set({ hasConsentRecord: value });
  },
  setConsentHydrated: (value) => {
    set({ consentHydrated: value });
  },
}));

export const useOnboardingStore = createSelectors(useOnboardingStoreBase);
