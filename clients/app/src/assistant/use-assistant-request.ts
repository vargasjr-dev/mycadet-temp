import { useEffect, useState } from "react";
import {
  AssistantResolutionSchema,
  type AssistantResolution,
} from "./resolution-contract";
import {
  listAssistantChoices,
  resolveAssistant,
  type AssistantRequest,
} from "./resolve-assistant";

export type AssistantRequestState =
  | AssistantResolution
  | { status: "loading" | "error" };

export function useAssistantRequest({
  apiBaseUrl = "/",
  origin,
  assistantId,
  listOnly = false,
}: Omit<AssistantRequest, "signal"> & { listOnly?: boolean }) {
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify([
    apiBaseUrl,
    origin,
    assistantId,
    listOnly,
    attempt,
  ]);
  const [result, setResult] = useState<{
    key: string;
    state: AssistantRequestState;
  }>();
  useEffect(() => {
    const controller = new AbortController();
    const settle = (state: AssistantRequestState) => setResult({ key, state });
    settle({ status: "loading" });
    const timer = setTimeout(() => {
      console.error(
        `Assistant request timed out after 10s (apiBaseUrl ${apiBaseUrl}, origin ${origin}, assistantId ${assistantId ?? "none"})`,
      );
      controller.abort();
      settle({ status: "error" });
    }, 10_000);
    void Promise.resolve()
      .then(() => {
        if (controller.signal.aborted) {
          return;
        }
        const request = {
          apiBaseUrl,
          origin,
          assistantId,
          signal: controller.signal,
        };
        return listOnly
          ? listAssistantChoices(request)
          : resolveAssistant(request);
      })
      .then(
        (value) => {
          if (controller.signal.aborted) {
            return;
          }
          clearTimeout(timer);
          const parsed = AssistantResolutionSchema.safeParse(value);
          if (!parsed.success) {
            console.error(
              "Assistant resolution did not match the contract:",
              parsed.error.message,
            );
            settle({ status: "error" });
            return;
          }
          if (
            parsed.data.status === "ready" &&
            assistantId &&
            parsed.data.assistant.id !== assistantId
          ) {
            console.error(
              `Assistant resolution returned ${parsed.data.assistant.id}, not the requested ${assistantId}`,
            );
            settle({ status: "error" });
            return;
          }
          settle(parsed.data);
        },
        (error) => {
          if (!controller.signal.aborted) {
            console.error("Assistant request failed:", error);
            clearTimeout(timer);
            settle({ status: "error" });
          }
        },
      );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [apiBaseUrl, origin, assistantId, listOnly, attempt, key]);
  const state: AssistantRequestState =
    result?.key === key ? result.state : { status: "loading" };
  return {
    state,
    retry: () => setAttempt((value) => value + 1),
  };
}
