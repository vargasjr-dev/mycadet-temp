import { useNavigate } from "react-router";

import { AccountShell } from "@app/components/account/account-shell";
import {
  NEW_ASSISTANT_PARAM,
  withSkipResearch,
} from "@app/domains/onboarding/onboarding-destination";
import { SETUP_NAVIGATE } from "@app/domains/onboarding/onboarding-navigation";
import { useTranslation } from "@app/i18n";
import { routes } from "@app/utils/routes";
import { Button } from "@mycadet/design-library/components/button";

/**
 * Platform onboarding welcome / front door. Ported from web's
 * `/assistant/onboarding/start` (bucket D of the unbundling plan) — now
 * `/account/onboarding/start`, rendered with the account screens' compact
 * chrome.
 *
 * The in-SPA landing spot for "Back" in platform mode (its only happy-path
 * predecessor, hosting, is local-only, and the marketing host `/` would
 * navigate a Capacitor staging/dev shell onto production). Deliberately a
 * single-CTA welcome: the button re-enters the funnel at research, which
 * hatches the assistant. Not wired as the funnel entrypoint — reached only
 * via Back — so the happy path is unchanged.
 */
export function StartScreen() {
  const { t } = useTranslation("account");
  const navigate = useNavigate();

  return (
    <AccountShell>
      <div className="flex flex-col items-center text-center text-[var(--content-default)]">
        <h1 className="text-3xl font-semibold tracking-tight">
          {t("welcome.title")}
        </h1>
        <p className="mt-3 text-body-medium-lighter text-[var(--content-tertiary)]">
          {t("welcome.body")}
        </p>

        <div className="mt-10 flex w-full max-w-sm flex-col">
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
    </AccountShell>
  );
}
