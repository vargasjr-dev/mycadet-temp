import { useNavigate } from "react-router";

import { AuthWelcomeScreen } from "@app/components/auth-welcome-screen";
import { listAssistants } from "@app/assistant/api";
import { SETUP_NAVIGATE } from "@app/domains/onboarding/onboarding-navigation";
import { useTranslation } from "@app/i18n";
import { routes } from "@app/utils/routes";

/**
 * `/account/onboarding/welcome` — the local client's front door. Shares its
 * screen with `/account/login`; the account this build doesn't require is what
 * makes the difference, so the second button walks past the login entirely.
 */
export function WelcomeScreen() {
  const { t } = useTranslation("account");
  const navigate = useNavigate();

  const handleContinueWithoutAccount = () => {
    // `replace`, like every other step of the setup flow: the funnel occupies a
    // single history entry so a Back press can never re-enter it (see
    // `SETUP_NAVIGATE` in `onboarding-navigation.ts`). The list assistants api
    // owns the "already have assistants" answer — no session (the literal
    // no-account path) reads as none, so the flow lands on hosting.
    void listAssistants().then((result) => {
      if (result.ok && result.data.length > 0) {
        void navigate(routes.assistant, SETUP_NAVIGATE);
      } else {
        void navigate(routes.account.selectAssistant, SETUP_NAVIGATE);
      }
    });
  };

  return (
    <AuthWelcomeScreen
      returnTo={null}
      secondary={{
        label: t("welcome.continueWithoutAccount"),
        onSelect: handleContinueWithoutAccount,
      }}
    />
  );
}
