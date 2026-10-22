import { useNavigate } from "react-router";

import { OnboardingLayout } from "@/components/onboarding-layout";
import {
  NEW_ASSISTANT_PARAM,
  withSkipResearch,
} from "@/domains/onboarding/onboarding-destination";
import { SETUP_NAVIGATE } from "@/domains/onboarding/onboarding-navigation";
import { useTranslation } from "@/i18n";
import { routes } from "@/utils/routes";
import { Button } from "@mycadet/design-library/components/button";

/**
 * Platform onboarding welcome / front door.
 *
 * The in-SPA landing spot for "Back" in platform mode (its only happy-path
 * predecessor, hosting, is local-only, and the marketing host `/` would
 * navigate a Capacitor staging/dev shell onto production). Deliberately a
 * single-CTA welcome: the button re-enters the funnel at research, which
 * hatches the assistant. Not wired as the funnel entrypoint — reached only
 * via Back — so the happy path is unchanged.
 */
export function StartScreen() {
  const { t } = useTranslation("onboarding");
  const navigate = useNavigate();

  return (
    <OnboardingLayout avatarWave="around">
      <div className="mx-auto flex min-h-screen w-full max-w-xl flex-col items-center px-6 pb-40 md:min-h-full md:pb-6 text-[var(--content-default)]">
        <div className="flex flex-1 flex-col items-center justify-center">
          <h1
            className="text-3xl font-semibold tracking-tight"
            style={{ animation: "fadeInUp 0.5s ease-out 0.1s both" }}
          >
            {t("welcome.title")}
          </h1>
          <p
            className="mt-3 text-center text-body-medium-lighter text-[var(--content-tertiary)]"
            style={{ animation: "fadeInUp 0.5s ease-out 0.3s both" }}
          >
            {t("welcome.body")}
          </p>

          <div
            className="mt-10 flex w-full max-w-sm flex-col"
            style={{ animation: "fadeInUp 0.5s ease-out 0.5s both" }}
          >
            <Button
              variant="primary"
              size="large"
              fullWidth
              onClick={() =>
                void navigate(
                  withSkipResearch(
                    `${routes.onboarding.research}?${NEW_ASSISTANT_PARAM}=1`,
                  ),
                  SETUP_NAVIGATE,
                )
              }
            >
              {t("startScreen.createAssistant")}
            </Button>
          </div>
        </div>
      </div>
    </OnboardingLayout>
  );
}
