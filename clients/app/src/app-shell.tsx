"use client";

import { CloudOff } from "lucide-react";
import { useState } from "react";
import { useAssistantRequest } from "./assistant/use-assistant-request";
import { AppI18nProvider } from "./i18n/provider";
import { useTranslation } from "./i18n/react";
import { AssistantFrame } from "./shell/assistant-frame";

export interface AppShellProps {
  apiBaseUrl?: string;
  assistantId?: string;
  location: string;
  origin: string;
  mountPath?: string;
  onNavigate(path: string, options: { replace: boolean }): void;
  title?: string;
}

/** Portable React entry. Resolves assistants through the host API; the host owns browser navigation. */
export function AppShell(props: AppShellProps) {
  return (
    <AppI18nProvider>
      <AssistantShell key={props.assistantId} {...props} />
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
  title,
}: AppShellProps) {
  const { t } = useTranslation("account");
  const [selectedId, select] = useState<string | undefined>(assistantId);
  const { state, retry: reload } = useAssistantRequest({
    apiBaseUrl,
    origin,
    assistantId: selectedId,
  });
  if (state.status !== "ready") {
    return (
      <div role={state.status === "notReady" ? "alert" : "status"}>
        {state.status === "notReady" ? (
          <NotReadyBody />
        ) : (
          <p>{t(`appShell.${state.status}`)}</p>
        )}
        {state.status === "selection" &&
          state.assistants.map((assistant) => (
            <button
              key={assistant.id}
              type="button"
              onClick={() => select(assistant.id)}
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

/** The 409 "assistant is not ready" resolution — deliberately NOT the
 * starting sentiment: the API only reports that the assistant isn't ready
 * (never hatched, stopped, or mid-release-resolution), so the panel says
 * exactly that and retry is the action. Modeled on the web app's
 * ActiveAssistantGate error panel (CloudOff + title + body); inline styles
 * so the portable bundle and the standalone build render it identically.
 */
function NotReadyBody() {
  const { t } = useTranslation("account");
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: 8,
      }}
    >
      <CloudOff size={20} aria-hidden="true" />
      <p style={{ margin: 0, fontWeight: 600 }}>
        {t("appShell.notReadyTitle")}
      </p>
      <p style={{ margin: 0, maxWidth: 420 }}>{t("appShell.notReadyBody")}</p>
    </div>
  );
}
