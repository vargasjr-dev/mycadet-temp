import { ArrowLeft, Check, Cloud, Laptop } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router";

import { AccountShell } from "@app/components/account/account-shell";
import { handleRadioCardArrowNav } from "@app/components/account/radio-card-nav";
import { ExternalAnchor } from "@app/components/external-anchor";
import { NEW_ASSISTANT_PARAM } from "@app/domains/onboarding/onboarding-destination";
import { SETUP_NAVIGATE } from "@app/domains/onboarding/onboarding-navigation";
import { setPendingProviderKey } from "@app/domains/onboarding/provider-key";
import { useAuthStore } from "@app/stores/auth-store";
import { useTranslation } from "@app/i18n";
import { docsUrl, routes } from "@app/utils/routes";
import { Button } from "@mycadet/design-library/components/button";
import type { Remote } from "@mycadet/local-mode/contract";

interface HostingOption {
  mode: Remote;
  label: string;
  subtitle: string;
  icon: ReactNode;
}

const HOSTING_OPTIONS: HostingOption[] = [
  {
    mode: "cloud",
    label: "Cadet Cloud",
    subtitle:
      "Always on, 24/7, even when your computer is off. Runs on Cadet's secure infrastructure.",
    icon: <Cloud className="h-5 w-5 shrink-0" />,
  },
  {
    mode: "local",
    label: "Local",
    subtitle:
      "Runs directly on your machine. Your data never leaves your computer.",
    icon: <Laptop className="h-5 w-5 shrink-0" />,
  },
];

/**
 * The funnel's hosting choice, ported from web's
 * `/assistant/onboarding/hosting` — now `/account/onboarding/hosting`, rendered
 * with the account screens' compact chrome. Without a live cloud session the
 * cloud card carries the login hand-off to the app's own login page.
 */
export function HostingScreen() {
  const { t } = useTranslation("account");
  const navigate = useNavigate();
  // The resolver's funnel fork reads the same verdict: a live cloud session.
  const hasCloudSession = useAuthStore((s) => s.cloudSession === "present");
  const [selected, setSelected] = useState<Remote>(
    hasCloudSession ? "cloud" : "local",
  );

  const showLogin = !hasCloudSession;

  const onContinue = () => {
    if (selected === "cloud") {
      // Cloud is managed: drop any provider key staged from a prior
      // Local/Docker visit so it can't leak into a later local hatch.
      setPendingProviderKey(null);
      // Cloud skips the api-key step, so this is the handoff into research
      // (consent settles at the shell's screen before the funnel runs) and it
      // carries the marker itself.
      void navigate(
        `${routes.onboarding.research}?${NEW_ASSISTANT_PARAM}=1`,
        SETUP_NAVIGATE,
      );
    } else {
      void navigate(
        `${routes.account.onboarding.apiKey}?hosting=${selected}`,
        SETUP_NAVIGATE,
      );
    }
  };

  const onBack = () => {
    void navigate(routes.account.selectAssistant, SETUP_NAVIGATE);
  };

  return (
    <AccountShell>
      <div className="flex w-full flex-col items-center text-center text-[var(--content-default)]">
        <h1 className="text-3xl font-semibold tracking-tight">
          {t("hostingScreen.title")}
        </h1>
        <p className="mt-3 text-body-medium-lighter text-[var(--content-tertiary)]">
          {t("hostingScreen.body")}{" "}
          <ExternalAnchor
            href={docsUrl(routes.docs.hostingOptions)}
            tone="quiet"
            glyph={false}
          >
            {t("hostingScreen.needHelp")}
          </ExternalAnchor>
        </p>

        <div
          role="radiogroup"
          aria-label={t("hostingScreen.optionsAriaLabel")}
          onKeyDown={handleRadioCardArrowNav}
          className="mt-8 grid w-full gap-2"
        >
          {HOSTING_OPTIONS.map((opt) => (
            <HostingCard
              key={opt.mode}
              option={opt}
              selected={selected === opt.mode}
              tabStop={selected === opt.mode}
              onSelect={() => setSelected(opt.mode)}
              loginLabel={t("actions.loginToUse")}
              onLogin={
                opt.mode === "cloud" && showLogin
                  ? () => {
                      void navigate(
                        `${routes.account.login}?returnTo=${encodeURIComponent(routes.account.onboarding.hosting)}`,
                      );
                    }
                  : undefined
              }
            />
          ))}
        </div>

        <div className="mt-8 w-full">
          <Button variant="primary" size="large" fullWidth onClick={onContinue}>
            {t("actions.continue")}
          </Button>
        </div>
        <div className="mt-3">
          <Button
            variant="ghost"
            size="compact"
            className="text-[var(--content-tertiary)]"
            leftIcon={<ArrowLeft />}
            onClick={onBack}
          >
            {t("actions.back")}
          </Button>
        </div>
      </div>
    </AccountShell>
  );
}

function HostingCard({
  option,
  selected,
  tabStop,
  onSelect,
  loginLabel,
  onLogin,
}: {
  option: HostingOption;
  selected: boolean;
  /** The radiogroup's single roving tab stop lands on this card. */
  tabStop: boolean;
  onSelect: () => void;
  loginLabel: string;
  /** Present on the cloud card when logging in brings the session. */
  onLogin?: () => void;
}) {
  return (
    <div
      role="radio"
      aria-checked={selected}
      tabIndex={tabStop ? 0 : -1}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={[
        "group flex w-full items-center gap-3 rounded-lg border p-3 text-left",
        "transition-all duration-200 ease-out",
        "cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary-base)]",
        selected
          ? "border-[var(--primary-base)] bg-[var(--surface-lift)]"
          : "border-[var(--border-base)] bg-[var(--surface-lift)]/60 hover:border-[var(--border-element)] hover:bg-[var(--surface-lift)]",
      ].join(" ")}
    >
      <div
        className={[
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors duration-200",
          selected
            ? "bg-[var(--primary-base)] text-[var(--surface-base)]"
            : "bg-[var(--surface-active)]/40 text-[var(--content-secondary)]",
        ].join(" ")}
      >
        {option.icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-body-medium-default text-[var(--content-default)]">
            {option.label}
          </span>
        </div>
        <span className="mt-1 line-clamp-2 text-label-medium-default leading-[14px] text-[var(--content-tertiary)]">
          {option.subtitle}
        </span>
      </div>
      {onLogin && (
        <Button
          variant="primary"
          size="regular"
          className="shrink-0"
          onClick={onLogin}
        >
          {loginLabel}
        </Button>
      )}
      <div
        className={[
          "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 transition-all duration-200",
          selected
            ? "border-[var(--primary-base)] bg-[var(--primary-base)]"
            : "border-[var(--border-element)] group-hover:border-[var(--content-tertiary)]",
        ].join(" ")}
      >
        {selected && (
          <Check
            className="h-3 w-3 text-[var(--surface-base)]"
            strokeWidth={3}
          />
        )}
      </div>
    </div>
  );
}
