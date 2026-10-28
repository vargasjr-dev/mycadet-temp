import { Navigate, useLocation, useNavigate } from "react-router";
import { AppShell } from "@app/app-shell";
import { useTranslation } from "@app/i18n";
import { readInjectedConfig } from "@app/lib/injected-config";
import {
  assistantSelectionState,
  selectedAssistantState,
} from "@app/assistant/assistant-selection";
import { routes } from "@app/utils/routes";
import { useConsentGate } from "@app/domains/consent/use-consent-gate";

export function AssistantPage() {
  useTranslation();
  const config = readInjectedConfig();
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
      <Navigate
        to={`${routes.account.consent}?returnTo=${returnTo}`}
        replace
      />
    );
  }

  return (
    <AppShell
      assistantId={selection?.id ?? config?.assistantId}
      // A paired selection rides its own gateway path; every served surface
      // resolves same-origin — the webview-only shells resolve against the
      // host-stamped baseUrl.
      apiBaseUrl={selection?.apiBase ?? config?.baseUrl}
      location={`${location.pathname}${location.search}${location.hash}`}
      onNavigate={(path, options) => {
        void navigate(path, {
          ...options,
          state: selection
            ? assistantSelectionState(selection.id, selection.apiBase)
            : undefined,
        });
      }}
    />
  );
}
