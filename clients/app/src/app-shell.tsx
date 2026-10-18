"use client";

import { useState, type ReactNode } from "react";
import {
  useAssistantRequest,
  type AssistantRequestState,
} from "./assistant/use-assistant-request";
import { AppI18nProvider } from "./i18n/provider";
import { useTranslation } from "./i18n/react";
import { AssistantFrame } from "./shell/assistant-frame";

export type AppShellStatus = Exclude<
  AssistantRequestState,
  { status: "ready" }
>;
export interface AppShellProps {
  apiBaseUrl?: string;
  assistantId?: string;
  location: string;
  origin: string;
  mountPath?: string;
  onNavigate(path: string, options: { replace: boolean }): void;
  renderStatus?: (state: AppShellStatus, retry: () => void) => ReactNode;
  title?: string;
}

/** Portable React entry. Resolves assistants through the host API; the host owns browser navigation. */
export function AppShell(props: AppShellProps) {
  return (
    <AppI18nProvider>
      <AssistantShell {...props} />
    </AppI18nProvider>
  );
}

function AssistantShell({
  apiBaseUrl = "/",
  assistantId,
  location,
  origin,
  mountPath = "/assistant",
  onNavigate,
  renderStatus,
  title,
}: AppShellProps) {
  const { t } = useTranslation("account");
  const [selection, select] = useState<{
    id: string;
    apiBaseUrl: string;
    origin: string;
  }>();
  const selectedId =
    assistantId ??
    (selection?.apiBaseUrl === apiBaseUrl && selection.origin === origin
      ? selection.id
      : undefined);
  const { state, retry: reload } = useAssistantRequest({
    apiBaseUrl,
    origin,
    assistantId: selectedId,
  });
  if (state.status !== "ready") {
    return renderStatus && state.status !== "selection" ? (
      renderStatus(state, reload)
    ) : (
      <div role="status">
        <p>{t(`appShell.${state.status}`)}</p>
        {state.status === "selection" &&
          state.assistants.map((assistant) => (
            <button
              key={assistant.id}
              type="button"
              onClick={() => select({ id: assistant.id, apiBaseUrl, origin })}
            >
              {assistant.name || assistant.id}
            </button>
          ))}
        {!assistantId && selectedId && (
          <button type="button" onClick={() => select(undefined)}>
            {t("appShell.chooseAnother")}
          </button>
        )}
        {state.status !== "loading" && (
          <button type="button" onClick={reload}>
            {t("appShell.retry")}
          </button>
        )}
      </div>
    );
  }
  const assistant = state.assistant;
  return (
    <AssistantFrame
      key={`${assistant.id}:${assistant.version}:${assistant.url}:${mountPath}:${origin}`}
      assistant={assistant}
      location={location}
      origin={origin}
      mountPath={mountPath}
      onNavigate={onNavigate}
      title={title ?? t("appShell.title")}
    />
  );
}
