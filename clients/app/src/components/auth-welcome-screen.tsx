import type { ReactNode } from "react";
import { Link } from "react-router";

import { AccountShell } from "@app/components/account/account-shell";
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

/**
 * Account welcome actions around the app-owned copy and shell. The login
 * hand-off is not wired up yet: the primary button reads Coming Soon! and
 * stays inert, leaving the secondary action as the only way forward.
 */
export function AuthWelcomeScreen({
  secondary,
}: {
  secondary: WelcomeSecondaryAction;
}) {
  const { t } = useTranslation("account");

  const secondaryButton = secondary.href ? (
    <Button variant="ghost" size="regular" fullWidth asChild>
      <Link to={secondary.href}>{secondary.label}</Link>
    </Button>
  ) : (
    <Button
      variant="ghost"
      size="regular"
      fullWidth
      onClick={secondary.onSelect}
    >
      {secondary.label}
    </Button>
  );

  return (
    <WelcomeScreenShell>
      <WelcomeScreenCopy>
        <Button variant="primary" size="large" fullWidth disabled>
          {t("welcome.comingSoon")}
        </Button>
        {secondaryButton}
      </WelcomeScreenCopy>
    </WelcomeScreenShell>
  );
}
