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

  // The consent re-review gates the assistant: a user whose acked versions
  // went stale (a release bumped the frozen required versions — the only way
  // staleness materializes, since it ships with the client) settles it HERE,
  // in the shell, before any assistant mounts. First-time consent is not the
  // shell's: a user with no consent record belongs to the onboarding funnel
  // inside the assistant, which frames and sequences first consent itself.
  const consent = useConsentGate();
  if (
    consent.settled &&
    consent.hasPlatformSession &&
    consent.currency?.hasConsentRecord &&
    (!consent.currency.tos || !consent.currency.privacy)
  ) {
    const returnTo = encodeURIComponent(
      `${location.pathname}${location.search}${location.hash}`,
    );
    return (
      <Navigate
        to={`${routes.account.consent.reviewTerms}?returnTo=${returnTo}`}
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
      // router, so it resolves against the stamped cloudUrl.
      apiBaseUrl={
        selection?.apiBase ??
        (isNativePlatform() ? config?.cloudUrl : undefined)
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
