import { useState } from "react";
import { useLocation } from "react-router";

import { useTranslation } from "@app/i18n";
import {
  AuthWelcomeScreen,
  WelcomeScreenCopy,
  WelcomeScreenShell,
} from "@app/components/auth-welcome-screen";
import { AuthWaitSpinner } from "@app/domains/account/components/auth-wait-spinner";
import { useReturnToShortCircuit } from "@app/domains/account/hooks/use-return-to-short-circuit";
import {
  isUserCancelledAuthError,
  nativeAuthErrorDetail,
  nativeAuthErrorKey,
} from "@app/domains/account/native-auth-error";
import { withPreservedAttribution } from "@app/domains/account/attribution";
import { captureError } from "@mycadet/design-library/utils/capture-error";
import {
  startNativeLogin,
  useIsNativePlatform,
} from "@web/runtime/native-auth";
import { routes } from "@app/utils/routes";
import { Button } from "@mycadet/design-library";

/** Native account login through the cloud browser auth surface. */
function NativeLoginForm({ returnTo }: { returnTo: string | null }) {
  const { t } = useTranslation("account");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const triggerAuth = async () => {
    setErrorMessage(null);
    setLoading(true);
    try {
      await startNativeLogin({ returnTo: returnTo ?? null });
    } catch (err) {
      if (isUserCancelledAuthError(err)) {
        setLoading(false);
        return;
      }
      // Report every real failure, classified or not. This is the screen the
      // "I tried to log in and it errored right away" reports come from, and
      // until now the classified branch logged nothing at all — so the reports
      // arrived with no trace of which refusal the cloud issued.
      captureError(err, {
        context: "native_login",
        tags: { authError: nativeAuthErrorDetail(err) ?? "unclassified" },
      });
      setErrorMessage(t(nativeAuthErrorKey(err)));
      setLoading(false);
    }
  };

  const handleSignIn = () => {
    void triggerAuth();
  };

  return (
    <WelcomeScreenShell>
      <WelcomeScreenCopy error={errorMessage}>
        <Button
          type="button"
          variant="primary"
          size="large"
          fullWidth
          onClick={handleSignIn}
          disabled={loading}
        >
          {t("loginPage.signIn")}
        </Button>
      </WelcomeScreenCopy>
    </WelcomeScreenShell>
  );
}

/** Account browser and Electron login. */
function WebLoginForm({ returnTo }: { returnTo: string | null }) {
  const { t } = useTranslation("account");
  // Keep URL-borne attribution alive across the pivot to signup.
  const { search } = useLocation();
  const signUpHref = withPreservedAttribution(
    returnTo
      ? `${routes.account.signup}?returnTo=${encodeURIComponent(returnTo)}`
      : routes.account.signup,
    search,
  );

  return (
    <AuthWelcomeScreen
      returnTo={returnTo}
      errorContext="web_login"
      secondary={{ label: t("loginPage.signUp"), href: signUpHref }}
    />
  );
}

/**
 * Branded sign-in screen for `/account/login`.
 *
 * Delegates to `NativeLoginForm` (Capacitor native) or `WebLoginForm`
 * (standard browser / Electron) based on platform detection.
 *
 * `useReturnToShortCircuit` owns whether an existing session skips OAuth and
 * lands on the `returnTo` destination directly — the same decision
 * `SignupPage` makes. Only the loading shell differs.
 */
export function LoginPage() {
  const isNative = useIsNativePlatform();
  const shortCircuit = useReturnToShortCircuit();

  // Hold the same account shell while the session probe settles.
  if (shortCircuit.kind === "wait") {
    return (
      <WelcomeScreenShell>
        <AuthWaitSpinner />
      </WelcomeScreenShell>
    );
  }
  if (shortCircuit.kind === "redirect") {
    return shortCircuit.node;
  }

  if (isNative) {
    return <NativeLoginForm returnTo={shortCircuit.returnTo} />;
  }
  return <WebLoginForm returnTo={shortCircuit.returnTo} />;
}
