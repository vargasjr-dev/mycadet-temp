import { useLocation, useNavigate } from "react-router";
import { AppShell } from "@app/app-shell";
import { currentLocale, useTranslation } from "@app/i18n";
import { readInjectedConfig } from "@app/lib/injected-config";
import {
  assistantSelectionState,
  selectedAssistantId,
} from "@app/assistant/assistant-selection";

export function AssistantPage() {
  useTranslation();
  const config = readInjectedConfig();
  const location = useLocation();
  const navigate = useNavigate();
  const selection = selectedAssistantId(location.state, config ?? {});
  return (
    <AppShell
      apiBaseUrl={config?.cloudUrl}
      assistantId={selection ?? config?.assistantId}
      location={`${location.pathname}${location.search}${location.hash}`}
      origin={window.location.origin}
      locale={currentLocale()}
      onNavigate={(path, options) => {
        void navigate(path, {
          ...options,
          state: selection
            ? assistantSelectionState(selection, config ?? {})
            : undefined,
        });
      }}
    />
  );
}
