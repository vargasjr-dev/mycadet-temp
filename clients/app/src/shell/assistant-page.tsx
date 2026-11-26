import {
  Navigate,
  useLocation,
  useNavigate,
  useOutletContext,
} from "react-router";
import { AppShell } from "@app/app-shell";
import { VellumOfferCard } from "@app/shell/vellum-offer-card";
import { useTranslation } from "@app/i18n";
import { selectedAssistantState } from "@app/assistant/assistant-selection";
import { routes } from "@app/utils/routes";
import { useConsentGate } from "@app/domains/consent/use-consent-gate";

export function AssistantPage() {
  useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const onShareFeedback = useOutletContext<(() => void) | undefined>();
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
    <div className="flex h-screen flex-col">
      {/* The vellum migration offer rides the shell — an upgrading vellum
          user lands here, not in onboarding. */}
      <VellumOfferCard />
      <div className="min-h-0 flex-1">
        <AppShell
          onShareFeedback={onShareFeedback}
          assistantId={selection?.id}
          apiBaseUrl={selection?.apiBase}
          onNavigate={(path, options) => {
            void navigate(path, {
              ...options,
              // The selection state rides every frame-driven navigation
              // unwrapped-and-verbatim, so a reload of the deeper entry still
              // restores it (the reader parses the wrapped shape).
              state: location.state,
            });
          }}
        />
      </div>
    </div>
  );
}
