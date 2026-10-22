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
import { CHECKOUT_CONTINUE_PARAM } from "@/lib/billing/checkout-continuation";
import type { CheckoutIntent } from "@/lib/billing/checkout-intent";
import {
  readCheckoutIntent,
} from "@/lib/billing/checkout-intent";
import { buildCustomCheckoutSearch } from "@/lib/billing/custom-checkout-params";
import { isLocalClient } from "@/lib/local-mode";
import { postCheckoutHatchReturnTo } from "@/lib/navigation/navigation-resolver";
import {
  usePrivacyConsent,
  useTosAccepted,
} from "@/domains/onboarding/prefs";
import { isElectron } from "@/runtime/is-electron";
import { useIsNativePlatform } from "@/runtime/native-auth";
import { useGatewaySessionStore } from "@/stores/gateway-session-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { saveConsent } from "@/lib/consent/consent-persistence";
import { useTranslation } from "@/i18n";
import { PACKAGE_PARAM, routes } from "@/utils/routes";
import { Button } from "@mycadet/design-library/components/button";

export function PrivacyScreen() {
  const { t } = useTranslation("onboarding");
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const identityKey = useGatewaySessionStore.use.identityKey();
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
        userId: identityKey,
        tos: tosAccepted,
        privacy: privacyConsent,
      });

      // A completed checkout with nothing provisioned is funneled to the hatching
      // screen; an unconsented user is bounced here, and the funnel URL rides
      // along as `returnTo`. With consent now recorded, resume it rather than the
      // standard onboarding step: that step carries neither the cloud-hatch nor
      // the paid-return marker, so the purchased machine and storage would never
      // be waited for. Money has already changed hands, which is why this outranks
      // the pending-package resume below.
      const paidHatchReturnTo = postCheckoutHatchReturnTo(
        searchParams.get("returnTo"),
      );
      if (paidHatchReturnTo) {
        void navigate(
          skipResearch
            ? withSkipResearch(paidHatchReturnTo)
            : paidHatchReturnTo,
          SETUP_NAVIGATE,
        );
        return;
      }

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

      // A pricing-CTA signup stashes its chosen plan (see navigation-resolver
      // post-auth). With consent now recorded, resume checkout so payment happens
      // after consent and before the assistant hatches. Resume ONLY a
      // signup-marked intent (`resumeAfterOnboarding`): an ordinary billing-surface
      // stash (an abandoned CheckoutPage/takeover checkout) carries no marker, so
      // it's ignored here and left untouched for its own flow — onboarding proceeds
      // normally. The checkout route owns the marked stash's lifecycle from here —
      // re-stashing on a Stripe redirect, clearing it on an already-Pro no_op — so
      // this screen just hands off. Resuming only from this explicit click
      // (Start or Skip to chat), never a render effect, keeps consent and
      // checkout from looping.
      const checkoutIntent = readCheckoutIntent();
      if (checkoutIntent?.resumeAfterOnboarding === true) {
        const checkoutParams = checkoutResumeSearch(checkoutIntent);
        if (checkoutParams) {
          checkoutParams.set(CHECKOUT_CONTINUE_PARAM, onboardingNext);
          void navigate(
            `${routes.checkout}?${checkoutParams.toString()}`,
            SETUP_NAVIGATE,
          );
          return;
        }
      }

      void navigate(onboardingNext, SETUP_NAVIGATE);
    },
    [
      privacyConsent,
      isPreview,
      navigate,
      searchParams,
      tosAccepted,
      identityKey,
    ],
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

/**
 * The checkout query a signup-marked stash resumes with, or `null` when it
 * names nothing the checkout route could act on: a custom stash without the
 * storage tier the upgrade endpoint requires. Only the marker-free
 * billing-surface saves can write one, and those never resume here.
 */
function checkoutResumeSearch(intent: CheckoutIntent): URLSearchParams | null {
  if (intent.kind === "package") {
    return new URLSearchParams({ [PACKAGE_PARAM]: intent.packageKey });
  }
  if (intent.storageTier === null) {
    return null;
  }
  return buildCustomCheckoutSearch({
    machineTier: intent.machineTier,
    storageTier: intent.storageTier,
    creditTier: intent.creditTier,
  });
}
