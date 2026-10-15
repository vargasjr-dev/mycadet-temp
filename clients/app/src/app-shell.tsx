"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  AssistantResolutionSchema,
  type AssistantResolution,
  type ResolveAssistant,
} from "./assistant/resolution-contract";
import { AssistantFrame } from "./shell/assistant-frame";

export type AppShellStatus =
  | { status: "loading" | "error" }
  | Exclude<AssistantResolution, { status: "ready" }>;
export interface AppShellProps {
  resolveAssistant: ResolveAssistant;
  assistantId?: string;
  location: string;
  origin: string;
  mountPath?: string;
  onNavigate(path: string, options: { replace: boolean }): void;
  renderStatus?: (state: AppShellStatus, retry: () => void) => ReactNode;
  title?: string;
}

const labels = {
  loading: "Loading assistant…",
  error: "Unable to load assistant.",
  starting: "Your assistant is starting.",
  empty: "No assistant is available.",
  unauthenticated: "Please sign in to continue.",
};

/** Portable React entry. The host supplies transport and owns browser navigation. */
export function AppShell({
  resolveAssistant,
  assistantId,
  location,
  origin,
  mountPath = "/assistant",
  onNavigate,
  renderStatus,
  title,
}: AppShellProps) {
  const [result, setResult] = useState<{
    state: AssistantResolution | AppShellStatus;
    resolver: ResolveAssistant;
    assistantId?: string;
    attempt: number;
  }>();
  const [attempt, retry] = useState(0);
  const reload = () => retry((value) => value + 1);
  useEffect(() => {
    const controller = new AbortController();
    const setState = (state: AssistantResolution | AppShellStatus) =>
      setResult({ state, resolver: resolveAssistant, assistantId, attempt });
    setState({ status: "loading" });
    const timer = setTimeout(() => {
      controller.abort();
      setState({ status: "error" });
    }, 10_000);
    void Promise.resolve()
      .then(() =>
        controller.signal.aborted
          ? undefined
          : resolveAssistant({ assistantId, signal: controller.signal }),
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
              assistantId &&
              parsed.data.assistant.id !== assistantId)
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
  }, [resolveAssistant, assistantId, attempt]);

  const state: AssistantResolution | AppShellStatus =
    result?.resolver === resolveAssistant &&
    result.assistantId === assistantId &&
    result.attempt === attempt
      ? result.state
      : { status: "loading" };
  if (state.status !== "ready") {
    return renderStatus ? (
      renderStatus(state, reload)
    ) : (
      <div role="status">
        <p>{labels[state.status]}</p>
        {state.status !== "loading" && (
          <button type="button" onClick={reload}>
            Retry
          </button>
        )}
      </div>
    );
  }
  const assistant = state.assistant;
  return (
    <AssistantFrame
      key={`${assistant.id}:${assistant.ui.version}:${assistant.ui.entryUrl}:${assistant.runtime.baseUrl}:${mountPath}:${origin}`}
      assistant={assistant}
      location={location}
      origin={origin}
      mountPath={mountPath}
      onNavigate={onNavigate}
      title={title}
    />
  );
}
