import { ArrowLeft, Check, Cloud, Laptop } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
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

type HostingMode = "cadet-cloud" | "local" | "docker";

interface HostingOption {
  mode: HostingMode;
  label: string;
  subtitle: string;
  icon: ReactNode;
  disabled?: boolean;
  badge?: string;
}

function useHostingOptions(hasCloudSession: boolean): HostingOption[] {
  const cloudDisabled = !hasCloudSession;

  return [
    {
      mode: "cadet-cloud",
      label: "Cadet Cloud",
      subtitle:
        "Always on, 24/7, even when your computer is off. Runs on Cadet's secure infrastructure.",
      icon: <Cloud className="h-5 w-5 shrink-0" />,
      ...(cloudDisabled
        ? {
            disabled: true,
            badge: hasCloudSession ? "Limit Reached" : "Requires Account",
          }
        : {}),
    },
    {
      mode: "local",
      label: "Local",
      subtitle:
        "Runs directly on your machine. Your data never leaves your computer.",
      icon: <Laptop className="h-5 w-5 shrink-0" />,
    },
  ];
}

/**
 * The funnel's hosting choice, ported from web's
 * `/assistant/onboarding/hosting` — now `/account/onboarding/hosting`, rendered
 * with the account screens' compact chrome. A live cloud session unlocks the
 * managed option; its absence locks the card behind a login hand-off to the
 * app's own login page.
 */
export function HostingScreen() {
  const { t } = useTranslation("account");
  const navigate = useNavigate();
  const hasCloudSession = useAuthStore((s) => s.sessionStatus === "authenticated");
  const options = useHostingOptions(hasCloudSession);
  const cloudDisabled = options.find((o) => o.mode === "cadet-cloud")?.disabled;
  const [selected, setSelected] = useState<HostingMode>(
    hasCloudSession && !cloudDisabled ? "cadet-cloud" : "local",
  );

  useEffect(() => {
    if (cloudDisabled && selected === "cadet-cloud") {
      setSelected("local");
    }
  }, [cloudDisabled, selected]);

  const showLogin = !hasCloudSession;

  const onContinue = () => {
    if (selected === "cadet-cloud") {
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
    void navigate(routes.account.onboarding.welcome, SETUP_NAVIGATE);
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
          {options.map((opt) => (
            <HostingCard
              key={opt.mode}
              option={opt}
              selected={selected === opt.mode}
              tabStop={selected === opt.mode}
              onSelect={() => {
                if (!opt.disabled) {
                  setSelected(opt.mode);
                }
              }}
              loginLabel={t("actions.loginToUse")}
              onLogin={
                opt.disabled && opt.mode === "cadet-cloud" && showLogin
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
  /** Present on the locked cloud card when logging in can unlock it. */
  onLogin?: () => void;
}) {
  const locked = !!option.disabled;
  // The badge explains a lock nothing on this card can lift (e.g. Limit
  // Reached); when logging in unlocks the card, the login button replaces it.
  const badge = onLogin ? undefined : option.badge;

  return (
    <div
      role={locked ? undefined : "radio"}
      aria-checked={locked ? undefined : selected}
      tabIndex={locked ? undefined : tabStop ? 0 : -1}
      onClick={locked ? undefined : onSelect}
      onKeyDown={
        locked
          ? undefined
          : (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect();
              }
            }
      }
      className={[
        "group flex w-full items-center gap-3 rounded-lg border p-3 text-left",
        "transition-all duration-200 ease-out",
        locked
          ? "border-[var(--border-base)] bg-[var(--surface-overlay)]"
          : "cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--primary-base)]",
        locked
          ? ""
          : selected
            ? "border-[var(--primary-base)] bg-[var(--surface-lift)]"
            : "border-[var(--border-base)] bg-[var(--surface-lift)]/60 hover:border-[var(--border-element)] hover:bg-[var(--surface-lift)]",
      ].join(" ")}
    >
      <div
        className={[
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors duration-200",
          selected && !locked
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
          {badge && (
            <span className="rounded-full bg-[var(--surface-active)]/40 px-2 py-0.5 text-label-medium-default text-[var(--content-tertiary)]">
              {badge}
            </span>
          )}
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
      {!locked && (
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
      )}
    </div>
  );
}
