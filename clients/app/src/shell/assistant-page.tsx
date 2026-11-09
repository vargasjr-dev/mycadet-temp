import { Navigate, useLocation, useNavigate } from "react-router";
import { AppShell } from "@app/app-shell";
import { useTranslation } from "@app/i18n";
import { selectedAssistantState } from "@app/assistant/assistant-selection";
import { routes } from "@app/utils/routes";
import { useConsentGate } from "@app/domains/consent/use-consent-gate";

export function AssistantPage() {
  useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const selection = selectedAssistantState(location.state);

  const consent = useConsentGate();
  if (
    consent.settled &&
    consent.hasCloudSession &&
    (!consent.currency?.hasConsentRecord ||
      !consent.currency.tos ||
      !consent.currency.privacy)
  ) {
    const returnTo = encodeURIComponent(
      `${location.pathname}${location.search}${location.hash}`,
    );
    return (
      <Navigate to={`${routes.account.consent}?returnTo=${returnTo}`} replace />
    );
  }

  return (
    <AppShell
      assistantId={selection?.id}
      apiBaseUrl={selection?.apiBase}
      onNavigate={(path, options) => {
        void navigate(path, {
          ...options,
          state: selection,
        });
      }}
    />
  );
}
