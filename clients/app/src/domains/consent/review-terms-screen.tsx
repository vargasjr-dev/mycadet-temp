import { ShieldCheck } from "lucide-react";
import { useCallback, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { Button } from "@mycadet/design-library/components/button";
import { Checkbox } from "@mycadet/design-library/components/checkbox";

import { useTranslation } from "@app/i18n";
import { sanitizeReturnTo } from "@app/utils/return-to";
import { routes } from "@app/utils/routes";
import { useAuthStore } from "@app/stores/auth-store";

import {
  PRIVACY_CONSENT_VERSION,
  TOS_CONSENT_VERSION,
  readConsentCurrency,
  saveConsent,
} from "./consent-persistence";
import { privacyChangeNotes, tosChangeNotes } from "./consent-changelog";

/**
 * The shell's consent screen: first consent AND stale-version re-reviews
 * happen HERE, before the assistant (web) mounts. Per the unbundling ruling,
 * consent takes place at the app shell, outside of an assistant — the
 * required versions are frozen build constants, so a re-review materializes
 * exactly when a release relaunches the shell, and the boot gate routes
 * first-time users (no acks at all) here with the welcome framing.
 */
export function ReviewTermsScreen() {
  const { t } = useTranslation("consent");
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const user = useAuthStore.use.user();
  const logout = useAuthStore.use.logout();
  const userId = user?.id ?? null;

  // Mount-time read: the acks the shell routed here to address. The gate
  // decided on these values moments ago; the screen snapshots them so a
  // checkbox the user checks doesn't unmount the section they checked.
  const [currencyAtMount] = useState(() => readConsentCurrency(userId));
  const tosStaleAtMount = !currencyAtMount.tos;
  const privacyStaleAtMount = !currencyAtMount.privacy;
  // A record-holder sees the "we've updated our terms" framing with change
  // notes; a first-time user sees the welcome framing. Both framings show
  // every axis the user still owes an ack for.
  const isFirstConsent = !currencyAtMount.hasConsentRecord;
  const showTos = tosStaleAtMount;
  const showPrivacy = privacyStaleAtMount;

  const [tosAccepted, setTosAccepted] = useState(tosStaleAtMount ? false : true);
  const [privacyConsent, setPrivacyConsent] = useState(
    privacyStaleAtMount ? false : true,
  );

  const continueDisabled =
    (showTos && !tosAccepted) || (showPrivacy && !privacyConsent);

  const onContinue = useCallback(() => {
    saveConsent({ userId, tos: tosAccepted, privacy: privacyConsent });

    const destination = sanitizeReturnTo(
      searchParams.get("returnTo"),
      routes.assistant,
    );
    void navigate(destination, { replace: true });
  }, [privacyConsent, navigate, searchParams, tosAccepted, userId]);

  const handleLogout = useCallback(async () => {
    await logout();
    void navigate(routes.account.login, { replace: true });
  }, [logout, navigate]);

  return (
    <div className="flex min-h-full items-center justify-center bg-[var(--surface-base)] px-6 py-16 text-[var(--content-default)]">
      <div className="flex w-full max-w-xl flex-col items-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full border border-[var(--border-subtle)] bg-[var(--surface-lift)]">
          <ShieldCheck
            className="h-6 w-6 text-[var(--content-secondary)]"
            strokeWidth={1.75}
          />
        </div>
        <h1 className="mt-5 text-3xl font-semibold tracking-tight">
          {isFirstConsent ? "Welcome to Cadet" : "Updated terms"}
        </h1>
        <p className="mt-3.5 text-center text-body-medium-lighter text-[var(--content-tertiary)]">
          {isFirstConsent
            ? "Please review and accept our terms to get started."
            : "We've updated our terms. Please review and accept to continue."}
        </p>

        <section className="mt-6 w-full">
          <p className="text-body-small-default font-medium text-[var(--content-secondary)]">
            {t("consentControls.agreements")}
          </p>
          {showTos && (
            <label className="mt-3 flex items-start gap-3">
              <Checkbox
                checked={tosAccepted}
                onCheckedChange={(checked) => setTosAccepted(checked === true)}
              />
              <span className="text-body-medium-lighter">
                {t("consentControls.agreeTo", { policy: "Terms of Service" })}
              </span>
            </label>
          )}
          {showPrivacy && (
            <label className="mt-3 flex items-start gap-3">
              <Checkbox
                checked={privacyConsent}
                onCheckedChange={(checked) => setPrivacyConsent(checked === true)}
              />
              <span className="text-body-medium-lighter">
                {t("consentControls.agreeTo", { policy: "the Privacy Policy" })}
              </span>
            </label>
          )}
          {!isFirstConsent &&
            showTos &&
            tosChangeNotes(TOS_CONSENT_VERSION).length > 0 && (
            <div className="mt-4">
              <p className="text-body-small-default font-medium text-[var(--content-secondary)]">
                {t("consentControls.whatsChanged")}
              </p>
              <ul className="mt-2 flex flex-col gap-1.5">
                {tosChangeNotes(TOS_CONSENT_VERSION).map((note) => (
                  <li
                    key={note}
                    className="flex gap-2.5 text-body-medium-lighter"
                  >
                    <span
                      aria-hidden
                      className="mt-[0.5em] h-1 w-1 flex-none rounded-full bg-[var(--content-tertiary)]"
                    />
                    <span>{note}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!isFirstConsent &&
            showPrivacy &&
            privacyChangeNotes(PRIVACY_CONSENT_VERSION).length > 0 && (
            <div className="mt-4">
              <p className="text-body-small-default font-medium text-[var(--content-secondary)]">
                {t("consentControls.whatsChanged")}
              </p>
              <ul className="mt-2 flex flex-col gap-1.5">
                {privacyChangeNotes(PRIVACY_CONSENT_VERSION).map((note) => (
                  <li
                    key={note}
                    className="flex gap-2.5 text-body-medium-lighter"
                  >
                    <span
                      aria-hidden
                      className="mt-[0.5em] h-1 w-1 flex-none rounded-full bg-[var(--content-tertiary)]"
                    />
                    <span>{note}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        <div className="mt-9 flex w-full flex-col gap-2">
          <Button
            variant="primary"
            size="large"
            fullWidth
            disabled={continueDisabled}
            onClick={onContinue}
          >
            {t("actions.continue")}
          </Button>
          <Button
            variant="outlined"
            size="large"
            fullWidth
            onClick={() => void handleLogout()}
          >
            {t("actions.logOut")}
          </Button>
        </div>
      </div>
    </div>
  );
}
