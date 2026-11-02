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
 * The shell's resolution flow: one same-origin `GET /v1/assistant` — the
 * serving host's operation composes the whole union (the lockfile's choice,
 * the entry gateway's identity, the caller's own auth verdict) and the hook
 * decodes it. The chooser picks instead of resolving, so it reads the list
 * endpoint through its own useAssistantChoices hook. The `assistantId` prop
 * keys re-resolution (a chooser hand-off re-runs the flow); the endpoint's
 * answer is the host's truth about what is served.
 */
export function useAssistantRequest({
  apiBaseUrl = "/",
  assistantId,
}: Omit<AssistantRequest, "signal" | "origin"> & { assistantId?: string }) {
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
