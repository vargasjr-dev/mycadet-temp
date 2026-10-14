import { useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";

import { AccountShell } from "@app/components/account/account-shell";
import { startAuthFlow } from "@app/lib/auth/auth-flow";
import { PROVIDER_ID } from "@app/domains/account/provider";
import { buildProviderCallbackUrl } from "@app/domains/account/provider-callback";
import {
  nativeAuthErrorDetail,
  nativeAuthErrorKey,
} from "@app/domains/account/native-auth-error";
import { captureError } from "@mycadet/design-library/utils/capture-error";
import { getElectronBridge } from "@app/runtime/electron-bridge";
import { useTranslation } from "@app/i18n";
import { Button } from "@mycadet/design-library/components/button";

/** The account action offered alongside login. */
export type WelcomeSecondaryAction =
  | { label: string; onSelect: () => void; href?: never }
  | { label: string; href: string; onSelect?: never };

/** Stable account layout shared by login and its session-probe wait. */
export function WelcomeScreenShell({ children }: { children: ReactNode }) {
  return (
    <AccountShell>
      <div className="flex flex-col items-center py-12 text-[var(--content-default)]">
        {children}
      </div>
    </AccountShell>
  );
}

/** Account welcome copy and actions, shared by browser and native login. */
export function WelcomeScreenCopy({
  error,
  children,
}: {
  /** Message from a handoff that failed, if the flow reported one. */
  error?: string | null;
  /** The action column: the primary button, and any secondary beneath it. */
  children: ReactNode;
}) {
  const { t } = useTranslation("account");

  return (
    <>
      <h1
        className="text-5xl font-normal tracking-tight md:text-4xl lg:text-5xl xl:text-6xl"
        style={{
          fontFamily: "var(--font-serif)",
          animation: "fadeInUp 0.5s ease-out 0.1s both",
        }}
      >
        {t("welcome.title")}
      </h1>
      <p
        className="mt-3 text-center text-body-large-lighter text-[var(--content-tertiary)]"
        style={{ animation: "fadeInUp 0.5s ease-out 0.3s both" }}
      >
        {t("welcome.body")}
      </p>

      {error && (
        <p className="mt-4 text-body-small-default text-[var(--system-negative-strong)]">
          {error}
        </p>
      )}

      <div
        className={`${error ? "mt-4" : "mt-15"} flex w-full max-w-sm flex-col gap-3`}
        style={{ animation: "fadeInUp 0.5s ease-out 0.5s both" }}
      >
        {children}
      </div>
    </>
  );
}

/** Account login actions around the app-owned welcome copy and shell. */
export function AuthWelcomeScreen({
  returnTo,
  secondary,
  errorContext,
}: {
  /** Destination after login; null leaves it to the post-auth fallback. */
  returnTo: string | null;
  secondary: WelcomeSecondaryAction;
  /** Error-report `context` tag for a failed handoff. */
  errorContext?: string;
}) {
  const { t } = useTranslation("account");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const flowIdRef = useRef(0);
  const login = async () => {
    const flowId = ++flowIdRef.current;
    setError(null);
    setLoading(true);
    try {
      await startAuthFlow(PROVIDER_ID, buildProviderCallbackUrl(returnTo), {
        returnTo,
      });
    } catch (err) {
      if (flowId !== flowIdRef.current) return;
      captureError(err, {
        context: errorContext ?? "account_login",
        tags: { authError: nativeAuthErrorDetail(err) ?? "unclassified" },
      });
      setError(t(nativeAuthErrorKey(err)));
      setLoading(false);
    }
  };
  const cancel = () => {
    flowIdRef.current++;
    setLoading(false);
    setError(null);
    if (getElectronBridge()) void getElectronBridge()?.auth?.cancelOAuth?.();
  };

  // Only the desktop shell keeps this screen up while the login runs: it hands
  // off to the system browser and waits for the deep link back. Every other
  // path navigates the page to the provider (`startProviderRedirect`, or the
  // loopback redirect in standalone local mode), so the screen is on its way
  // out and `cancel()` — which only reaches the Electron main process — has
  // nothing to stop. Offering Cancel there just flickers the button on its way
  // off screen; the button still goes inert so a second click can't open a
  // second flow.
  const cancellable = Boolean(getElectronBridge());
  const awaitingRedirect = loading && !cancellable;

  // Leaving the screen mid-login would strand the OAuth window (and, on
  // Electron, the main process's pending flow) behind us, so the secondary
  // action cancels first whichever way it leaves.
  const handleSecondary = () => {
    if (loading) {
      cancel();
    }
    secondary.onSelect?.();
  };

  const SECONDARY_CLASS = "h-11 text-base";
  const secondaryButton = secondary.href ? (
    <Button
      variant="ghost"
      size="regular"
      fullWidth
      className={SECONDARY_CLASS}
      asChild
    >
      <Link to={secondary.href} onClick={handleSecondary}>
        {secondary.label}
      </Link>
    </Button>
  ) : (
    <Button
      variant="ghost"
      size="regular"
      fullWidth
      className={SECONDARY_CLASS}
      onClick={handleSecondary}
    >
      {secondary.label}
    </Button>
  );

  return (
    <WelcomeScreenShell>
      <WelcomeScreenCopy error={error}>
        <Button
          variant="primary"
          size="large"
          fullWidth
          disabled={awaitingRedirect}
          onClick={loading && cancellable ? cancel : () => void login()}
        >
          {loading && cancellable ? t("welcome.cancel") : t("welcome.logIn")}
        </Button>
        {secondaryButton}
      </WelcomeScreenCopy>
    </WelcomeScreenShell>
  );
}
