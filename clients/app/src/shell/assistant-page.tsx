import { useLocation, useNavigate } from "react-router";
import { AppShell } from "@app/app-shell";
import { useTranslation } from "@app/i18n";
import { readInjectedConfig } from "@app/lib/injected-config";
import {
  assistantSelectionState,
  selectedAssistantState,
} from "@app/assistant/assistant-selection";

export function AssistantPage() {
  useTranslation();
  const config = readInjectedConfig();
  const location = useLocation();
  const navigate = useNavigate();
  const selection = selectedAssistantState(location.state);
  return (
    <AppShell
      assistantId={selection?.id ?? config?.assistantId}
      apiBaseUrl={selection?.apiBase}
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
