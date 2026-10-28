import { Navigate, useLocation, useNavigate } from "react-router";
import { AppShell } from "@app/app-shell";
import { useTranslation } from "@app/i18n";
import { readInjectedConfig } from "@app/lib/injected-config";
import { isNativePlatform } from "@app/runtime/native-platform";
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
      // A paired selection rides its own gateway path; served surfaces
      // leave this unset and resolve same-origin through their origin's
      // /v1 proxy; the native boot bundle's webview origin has no /v1
      // router, so it resolves against the stamped baseUrl.
      apiBaseUrl={
        selection?.apiBase ??
        (isNativePlatform() ? config?.baseUrl : undefined)
      }
      location={`${location.pathname}${location.search}${location.hash}`}
      origin={window.location.origin}
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
