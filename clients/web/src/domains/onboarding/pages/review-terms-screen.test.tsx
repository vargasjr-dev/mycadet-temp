import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// react-router: capture navigate() targets.
const navigateMock = mock((..._args: unknown[]) => {});
let searchParamsValue = new URLSearchParams();
mock.module("react-router", () => ({
  useNavigate: () => navigateMock,
  useSearchParams: () => [searchParamsValue, mock(() => {})],
}));

// Prefs hooks — mutable per-test so we can model each staleness combination.
let tosAccepted = true;
let privacyConsent = true;
// Whether the device holds ANY consent record for this user. Independent of
// the two legal flags above, which carry version CURRENCY only — both go false
// for a never-consented user AND for an established user whose acceptances
// predate the current required versions.
let hasConsentRecord = true;
const setTosAccepted = mock((next: boolean) => {
  tosAccepted = next;
});
const setPrivacyConsent = mock((next: boolean) => {
  privacyConsent = next;
});
mock.module("@/domains/onboarding/prefs", () => ({
  readTosAccepted: () => false,
  readPrivacyConsent: () => false,
  useTosAccepted: () => [tosAccepted, setTosAccepted],
  usePrivacyConsent: () => [privacyConsent, setPrivacyConsent],
  useHasConsentRecord: () => hasConsentRecord,
  readHasConsentRecord: () => hasConsentRecord,
  readConsentHydrated: () => true,
}));

const saveConsentMock = mock((_args: unknown) => {});
mock.module("@/lib/consent/consent-persistence", () => ({
  saveConsent: saveConsentMock,
  PRIVACY_CONSENT_VERSION: "2026-06-22",
  TOS_CONSENT_VERSION: "2026-06-08",
}));

mock.module("@/lib/auth/hard-navigate", () => ({
  hardNavigate: mock(() => {}),
}));
mock.module("@/runtime/is-electron", () => ({ isElectron: () => true }));
mock.module("@/stores/auth-store", () => ({
  useAuthStore: {
    use: { user: () => ({ id: "user-1" }), logout: () => mock(async () => {}) },
  },
  useHasCloudSession: () => true,
}));

// Light passthroughs for layout/design-library so the screen renders in happy-dom.
mock.module("@/components/onboarding-layout", () => ({
  OnboardingLayout: ({ children }: { children: React.ReactNode }) => children,
}));
mock.module("@mycadet/design-library/components/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));
mock.module("@mycadet/design-library/components/checkbox", () => ({
  Checkbox: ({
    checked,
    onCheckedChange,
    "aria-label": ariaLabel,
  }: {
    checked: boolean;
    onCheckedChange: (next: boolean) => void;
    "aria-label"?: string;
  }) => (
    <input
      type="checkbox"
      aria-label={ariaLabel}
      checked={checked}
      onChange={(e) => onCheckedChange(e.target.checked)}
    />
  ),
}));

const { ReviewTermsScreen } =
  await import("@/domains/onboarding/pages/review-terms-screen");

const TOS_LABEL = "I agree to the Terms of Service";
const PRIVACY_LABEL = "I agree to the Privacy and AI Data Sharing Policy";
const AI_LABEL = "I agree to the Privacy and AI Data Sharing Policy";

function continueButton(): HTMLButtonElement {
  return screen.getByText("Continue") as HTMLButtonElement;
}

describe("ReviewTermsScreen", () => {
  beforeEach(() => {
    navigateMock.mockClear();
    saveConsentMock.mockClear();
    searchParamsValue = new URLSearchParams();
    tosAccepted = true;
    privacyConsent = true;
    hasConsentRecord = true;
  });
  afterEach(cleanup);

  test("nothing stale (direct navigation) renders all sections and enables Continue", () => {
    // All consent current — e.g. the user typed /assistant/review-terms directly.
    render(<ReviewTermsScreen />);

    // Every section is shown rather than an empty page.
    expect(screen.getByLabelText(TOS_LABEL)).toBeTruthy();
    expect(screen.getByLabelText(AI_LABEL)).toBeTruthy();
    // Copy is the neutral review variant, not the "we've updated" wording.
    expect(screen.getByText("Terms")).toBeTruthy();
    expect(screen.getByText("Review your terms anytime.")).toBeTruthy();
    // Already-accepted consent means Continue is enabled immediately.
    expect(continueButton().disabled).toBe(false);
  });

  test("stale TOS renders its checkbox and gates Continue until checked", () => {
    tosAccepted = false; // tos stale
    const { rerender } = render(<ReviewTermsScreen />);

    const tosCheckbox = screen.getByLabelText(TOS_LABEL);
    expect(tosCheckbox).toBeTruthy();
    expect(continueButton().disabled).toBe(true);

    fireEvent.click(tosCheckbox);
    expect(setTosAccepted).toHaveBeenCalledWith(true);

    rerender(<ReviewTermsScreen />);
    // Staleness is snapshotted at mount, so the checkbox stays visible (now
    // showing the checked state) instead of unmounting the instant it's checked.
    const checkedTos = screen.getByLabelText(TOS_LABEL) as HTMLInputElement;
    expect(checkedTos).toBeTruthy();
    expect(checkedTos.checked).toBe(true);
    expect(continueButton().disabled).toBe(false);
  });

  test("first consent (nothing ever accepted) shows consent framing, no changelog", () => {
    // A user who arrived with an assistant but never consented — e.g. via the
    // bring-your-agent import, which replaces onboarding. No consent record is
    // what makes this first consent, not the stale legal flags.
    tosAccepted = false;
    privacyConsent = false;
    hasConsentRecord = false;
    const { rerender } = render(<ReviewTermsScreen />);

    expect(screen.getByText("Before You Start")).toBeTruthy();
    expect(screen.queryByText("Updated terms")).toBeNull();
    // No "what's changed" notes on a first-time consent — no baseline to diff.
    expect(screen.queryByText(/what's changed/i)).toBeNull();
    // Both legal checkboxes gate Continue.
    expect(continueButton().disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(TOS_LABEL));
    fireEvent.click(screen.getByLabelText(PRIVACY_LABEL));
    rerender(<ReviewTermsScreen />);
    expect(continueButton().disabled).toBe(false);
  });

  test("heading stays on 'Updated terms' after the last legal box is checked", () => {
    tosAccepted = false; // tos stale -> "Updated terms" heading
    const { rerender } = render(<ReviewTermsScreen />);

    expect(screen.getByText("Updated terms")).toBeTruthy();

    fireEvent.click(screen.getByLabelText(TOS_LABEL));
    rerender(<ReviewTermsScreen />);

    // Heading must not flip mid-flow once the box is checked.
    expect(screen.getByText("Updated terms")).toBeTruthy();
  });

  test("Continue persists the legal acceptance", () => {
    tosAccepted = false;
    const { rerender } = render(<ReviewTermsScreen />);

    fireEvent.click(screen.getByLabelText(TOS_LABEL));
    // The prefs mock isn't wired to React state — re-render so the checkbox
    // tick takes effect and Continue re-enables.
    rerender(<ReviewTermsScreen />);
    fireEvent.click(continueButton());

    expect(saveConsentMock).toHaveBeenCalledTimes(1);
    expect(saveConsentMock.mock.calls[0]?.[0]).toMatchObject({
      tos: true,
      privacy: true,
    });
  });

  test("both legal versions bumped for an EXISTING user is not first consent", () => {
    // Regression: `firstConsentAtMount` must key off the consent-record signal,
    // not off the two legal flags. Those carry version currency, so an
    // established user whose acceptances predate the current required versions
    // has both stale — previously misread as never-consented, which swapped in
    // first-time framing and suppressed the "what's changed" notes that are
    // the entire point of the re-review.
    tosAccepted = false;
    privacyConsent = false;
    hasConsentRecord = true; // they HAVE consented before
    render(<ReviewTermsScreen />);

    // Re-review framing, not first-time framing.
    expect(screen.getByText("Updated terms")).toBeTruthy();
    expect(screen.queryByText("Before You Start")).toBeNull();
  });
});
