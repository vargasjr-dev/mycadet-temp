"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  AssistantResolutionSchema,
  type AssistantResolution,
} from "./assistant/resolution-contract";
import { resolveAssistant } from "./assistant/resolve-assistant";
import { AppI18nProvider } from "./i18n/provider";
import { useTranslation } from "./i18n/react";
import type { SupportedLocale } from "./i18n/supported-locales";
import { AssistantFrame } from "./shell/assistant-frame";

export type AppShellStatus =
  | { status: "loading" | "error" }
  | Exclude<AssistantResolution, { status: "ready" }>;
export interface AppShellProps {
  apiBaseUrl?: string;
  organizationId?: string;
  assistantId?: string;
  location: string;
  origin: string;
  mountPath?: string;
  onNavigate(path: string, options: { replace: boolean }): void;
  renderStatus?: (state: AppShellStatus, retry: () => void) => ReactNode;
  title?: string;
  locale?: SupportedLocale;
}

/** Portable React entry. Resolves assistants through the host API; the host owns browser navigation. */
export function AppShell({ locale, ...props }: AppShellProps) {
  return (
    <AppI18nProvider locale={locale}>
      <AssistantShell {...props} />
    </AppI18nProvider>
  );
}

function AssistantShell({
  apiBaseUrl = "/",
  organizationId,
  assistantId,
  location,
  origin,
  mountPath = "/assistant",
  onNavigate,
  renderStatus,
  title,
}: AppShellProps) {
  const { t } = useTranslation("account");
  const [result, setResult] = useState<{
    state: AssistantResolution | AppShellStatus;
    apiBaseUrl: string;
    origin: string;
    organizationId?: string;
    assistantId?: string;
    attempt: number;
  }>();
  const [selection, select] = useState<{
    id: string;
    apiBaseUrl: string;
    origin: string;
    organizationId?: string;
  }>();
  const selectedId =
    assistantId ??
    (selection?.apiBaseUrl === apiBaseUrl &&
    selection.origin === origin &&
    selection.organizationId === organizationId
      ? selection.id
      : undefined);
  const [attempt, retry] = useState(0);
  const reload = () => retry((value) => value + 1);
  useEffect(() => {
    const controller = new AbortController();
    const setState = (state: AssistantResolution | AppShellStatus) =>
      setResult({
        state,
        apiBaseUrl,
        origin,
        organizationId,
        assistantId: selectedId,
        attempt,
      });
    setState({ status: "loading" });
    const timer = setTimeout(() => {
      controller.abort();
      setState({ status: "error" });
    }, 10_000);
    void Promise.resolve()
      .then(() =>
        controller.signal.aborted
          ? undefined
          : resolveAssistant({
              apiBaseUrl,
              origin,
              organizationId,
              assistantId: selectedId,
              signal: controller.signal,
            }),
      )
      .then(
        (result) => {
          if (controller.signal.aborted) {
            return;
          }
          clearTimeout(timer);
          const parsed = AssistantResolutionSchema.safeParse(result);
          if (
            !parsed.success ||
            (parsed.data.status === "ready" &&
              selectedId &&
              parsed.data.assistant.id !== selectedId)
          ) {
            setState({ status: "error" });
            return;
          }
          setState(parsed.data);
        },
        () => {
          if (!controller.signal.aborted) {
            clearTimeout(timer);
            setState({ status: "error" });
          }
        },
      );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [apiBaseUrl, origin, organizationId, selectedId, attempt]);

  const state: AssistantResolution | AppShellStatus =
    result?.apiBaseUrl === apiBaseUrl &&
    result.origin === origin &&
    result.organizationId === organizationId &&
    result.assistantId === selectedId &&
    result.attempt === attempt
      ? result.state
      : { status: "loading" };
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
              onClick={() =>
                select({ id: assistant.id, apiBaseUrl, origin, organizationId })
              }
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
