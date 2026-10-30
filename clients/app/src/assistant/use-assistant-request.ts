import { useEffect, useState } from "react";
import { describeError } from "./describe-error";
import {
  AssistantResolutionSchema,
  type AssistantResolution,
} from "./resolution-contract";
import { resolveAssistant, type AssistantRequest } from "./resolve-assistant";

export type AssistantRequestState =
  | AssistantResolution
  | { status: "loading" | "error" };

/**
 * The shell's resolution flow: it resolves one assistant's detail, falling
 * back to the list endpoint's summary when there is nothing (or more than
 * one) to resolve. The chooser picks instead of resolving, so it reads the
 * list endpoint through its own useAssistantChoices hook.
 */
export function useAssistantRequest({
  apiBaseUrl = "/",
  assistantId,
}: Omit<AssistantRequest, "signal" | "origin">) {
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify([apiBaseUrl, assistantId, attempt]);
  const [result, setResult] = useState<{
    key: string;
    state: AssistantRequestState;
  }>();
  useEffect(() => {
    const controller = new AbortController();
    const settle = (state: AssistantRequestState) => setResult({ key, state });
    settle({ status: "loading" });
    // The shell is same-origin by construction — every host (the desktop
    // protocol, the web dev server, the cloud takeover) proxies the API at
    // the page's own origin. Read inside the effect: SSR renders the shell
    // without a window, and the origin is a browser fact.
    const origin = window.location.origin;
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
        return resolveAssistant(request);
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
            console.error(
              `Assistant request failed: ${describeError(error)} (apiBaseUrl ${apiBaseUrl}, origin ${origin}, assistantId ${assistantId ?? "none"})`,
            );
            clearTimeout(timer);
            settle({ status: "error" });
          }
        },
      );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [apiBaseUrl, assistantId, attempt, key]);
  const state: AssistantRequestState =
    result?.key === key ? result.state : { status: "loading" };
  return {
    state,
    retry: () => setAttempt((value) => value + 1),
  };
}
