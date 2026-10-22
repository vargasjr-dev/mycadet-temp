import { useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { AgreementsCard } from "@/domains/onboarding/components/consent-controls";
import { OnboardingLayout } from "@/components/onboarding-layout";
import { StepIndicatorDots } from "@/domains/onboarding/components/step-indicator-dots";
import { isSelectedAssistantOnboarded } from "@/domains/onboarding/onboarded-assistant";
import { readSelectedAssistantId } from "@/assistant/selected-assistant-storage";
import {
  canSkipOnboardingResearch,
  isNewAssistantFunnel,
  onboardingDestinationAfterConsent,
  withSkipResearch,
} from "@/domains/onboarding/onboarding-destination";
import { SETUP_NAVIGATE } from "@/domains/onboarding/onboarding-navigation";
import { ATTRIBUTED_PLUGIN_PARAM } from "@/domains/onboarding/plugin-attribution";
import { isLocalClient } from "@/lib/local-mode";
import { usePrivacyConsent, useTosAccepted } from "@/domains/onboarding/prefs";
import { isElectron } from "@/runtime/is-electron";
import { useIsNativePlatform } from "@/runtime/native-auth";
import { useAuthStore } from "@/stores/auth-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { saveConsent } from "@/lib/consent/consent-persistence";
import { useTranslation } from "@/i18n";
import { PACKAGE_PARAM, routes } from "@/utils/routes";
import { Button } from "@mycadet/design-library/components/button";

export function PrivacyScreen() {
  const { t } = useTranslation("onboarding");
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const userId = useAuthStore.use.user()?.id ?? null;
  const electron = isElectron();
  const isNative = useIsNativePlatform();
  const [tosAccepted, setTosAcceptedReal] = useTosAccepted();
  const [privacyConsent, setPrivacyConsentReal] = usePrivacyConsent();
  const isPreview = searchParams.get("preview") === "true";
  const noop = useCallback((_next: boolean) => {}, []);
  const setTosAccepted = isPreview ? noop : setTosAcceptedReal;
  const setPrivacyConsent = isPreview ? noop : setPrivacyConsentReal;

  const showSkipToChat = canSkipOnboardingResearch();

  const onAdvance = useCallback(
    (skipResearch: boolean) => {
      if (isPreview) {
        // Developer "Replay Onboarding": preview mode does not advance to any
        // side-effecting onboarding route. Hatching is excluded from the preview
        // route allowlist in onboardingCompletedMiddleware (it has real side
        // effects), so Start and Skip to chat are no-ops here.
        return;
      }

      saveConsent({
        userId,
        tos: tosAccepted,
        privacy: privacyConsent,
      });

      const hostingParam = searchParams.get("hosting");
      const params = new URLSearchParams();
      if (hostingParam) {
        params.set("hosting", hostingParam);
      }
      // Carry the marketing plugin attribution forward so the research runner can
      // read it off the URL and pre-install that plugin (see `plugin-attribution`).
      const pluginParam = searchParams.get(ATTRIBUTED_PLUGIN_PARAM);
      if (pluginParam) {
        params.set(ATTRIBUTED_PLUGIN_PARAM, pluginParam);
      }
      const qs = params.toString();
      // A local-hosting onboarding (hosting=local/docker in a local-mode build)
      // must run the foreground local hatch first, so it goes to `hatching`, which
      // then redirects into the research flow. Cadet-Cloud goes straight to
      // research (managed background hatch). Skip-to-chat also uses hatching:
      // there is no research form, so the hatch screen provisions then hands off
      // to chat.
      const isLocalHatch =
        isLocalClient() &&
        hostingParam !== null &&
        hostingParam !== "cadet-cloud";
      const selectedAssistantOnboarded = isSelectedAssistantOnboarded(
        useResolvedAssistantsStore.getState().assistants,
        readSelectedAssistantId(),
      );
      const destination = onboardingDestinationAfterConsent({
        isLocalHatch,
        skipResearch,
        selectedAssistantOnboarded,
        newAssistant: isNewAssistantFunnel(searchParams),
      });
      const onboardingNext = skipResearch
        ? withSkipResearch(`${destination}${qs ? `?${qs}` : ""}`)
        : `${destination}${qs ? `?${qs}` : ""}`;

      void navigate(onboardingNext, SETUP_NAVIGATE);
    },
    [privacyConsent, isPreview, navigate, searchParams, tosAccepted, userId],
  );

  return (
    <OnboardingLayout avatarWave="beside">
      <div
        className={`mx-auto flex w-full max-w-xl flex-col items-center ${electron ? "min-h-full px-8 pt-21 pb-4 electron-prechat-type" : "px-6 py-16"} text-[var(--content-default)]`}
      >
        {isNative && (
          <div
            className="mb-8 flex w-full justify-center"
            style={{ animation: "fadeInUp 0.3s ease-out 0.1s both" }}
          >
            <StepIndicatorDots current={2} total={3} />
          </div>
        )}
        <h1
          className={
            electron
              ? "text-title-large"
              : "text-3xl font-semibold tracking-tight"
          }
          style={{ animation: "fadeInUp 0.5s ease-out 0.1s both" }}
        >
          {t("privacyScreen.title")}
        </h1>
        <p
          className={`text-center text-body-medium-lighter text-[var(--content-tertiary)] ${electron ? "mt-3.5" : "mt-4"}`}
          style={{ animation: "fadeInUp 0.5s ease-out 0.3s both" }}
        >
          {t("privacyScreen.body")}
        </p>

        <AgreementsCard
          electron={electron}
          privacyConsent={privacyConsent}
          tosAccepted={tosAccepted}
          onPrivacyChange={setPrivacyConsent}
          onTosChange={setTosAccepted}
          className="mt-6 w-full"
          style={{ animation: "fadeInUp 0.5s ease-out 0.5s both" }}
        />

        <div
          className={`mt-8 flex w-full flex-col ${electron ? "gap-2.5" : "gap-2"}`}
          style={{ animation: "fadeInUp 0.5s ease-out 0.55s both" }}
        >
          <Button
            variant="primary"
            size={electron ? "regular" : "large"}
            fullWidth
            disabled={!tosAccepted || !privacyConsent}
            onClick={() => onAdvance(false)}
          >
            {t("privacyScreen.start")}
          </Button>
          {showSkipToChat && (
            <Button
              variant="outlined"
              size={electron ? "regular" : "large"}
              fullWidth
              disabled={!tosAccepted || !privacyConsent}
              onClick={() => onAdvance(true)}
            >
              {t("privacyScreen.skipToChat")}
            </Button>
          )}
          {/*
           * Back's destination is mode-specific, but always stays inside the SPA
           * (react-router `navigate`, never a full-document nav). In local mode
           * hosting is the screen that leads here (welcome → hosting → privacy),
           * so go there deterministically rather than `navigate(-1)`. In platform
           * mode privacy IS the funnel entrypoint — hosting is local-only
           * (`enforceModeBoundary` bounces a cloud user off it to `/assistant`,
           * which trips a non-onboarding hatch) — so Back lands on the onboarding
           * `start` welcome screen instead. It must NOT leave the SPA for the
           * marketing host (`/`): on a Capacitor staging/dev shell that host's CTA
           * points at production `www.mycadet.ai/assistant`, so a full-document nav
           * would switch the native app off its own environment. `start` keeps the
           * running environment intact on web and native alike.
           */}
          <Button
            variant="ghost"
            size={electron ? "regular" : "large"}
            fullWidth
            onClick={() =>
              navigate(
                isLocalClient()
                  ? routes.onboarding.hosting
                  : routes.onboarding.start,
                SETUP_NAVIGATE,
              )
            }
          >
            {t("actions.back")}
          </Button>
        </div>
      </div>
    </OnboardingLayout>
  );
}
