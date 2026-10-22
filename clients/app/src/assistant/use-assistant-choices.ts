import { useEffect, useState } from "react";
import { AssistantListSchema, type AssistantList } from "./resolution-contract";
import { listAssistantChoices } from "./resolve-assistant";

/**
 * The chooser's request state: only what the list endpoint can answer, plus
 * the transport states every request carries. The single-assistant resolution
 * arms live in the shell's flow — the chooser is committed to choosing an
 * assistant, so there is no ready/notReady state to defend against here.
 */
export type AssistantChoicesState =
  | { status: "loading" | "error" }
  | AssistantList;

/**
 * The chooser's request hook: it calls only the list endpoint, and it is
 * SAME-ORIGIN by contract — `window.location.origin`, like every other
 * Cadet surface's chooser (the web dev server proxies /v1, the desktop
 * protocol handler forwards it, the edge and cloud takeovers route it, and
 * the mobile shells' native scheme handler resolves it). Naming a base here
 * would bypass the serving layer and lose its session handling. The shell's
 * resolution flow (one assistant's detail, or which arms redirect to this
 * chooser) stays in useAssistantRequest.
 */
export function useAssistantChoices() {
  const origin = window.location.origin;
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify([origin, attempt]);
  const [result, setResult] = useState<{
    key: string;
    state: AssistantChoicesState;
  }>();
  useEffect(() => {
    const controller = new AbortController();
    const settle = (state: AssistantChoicesState) => setResult({ key, state });
    settle({ status: "loading" });
    const timer = setTimeout(() => {
      console.error(
        `Assistant list request timed out after 10s (origin ${origin})`,
      );
      controller.abort();
      settle({ status: "error" });
    }, 10_000);
    void Promise.resolve()
      .then(() => {
        if (controller.signal.aborted) {
          return;
        }
        return listAssistantChoices({
          apiBaseUrl: "/",
          origin,
          signal: controller.signal,
        });
      })
      .then(
        (value) => {
          if (controller.signal.aborted) {
            return;
          }
          clearTimeout(timer);
          const parsed = AssistantListSchema.safeParse(value);
          if (!parsed.success) {
            console.error(
              "Assistant list did not match the contract:",
              parsed.error.message,
            );
            settle({ status: "error" });
            return;
          }
          settle(parsed.data);
        },
        (error) => {
          if (!controller.signal.aborted) {
            console.error("Assistant list request failed:", error);
            clearTimeout(timer);
            settle({ status: "error" });
          }
        },
      );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [attempt, key]);
  const state: AssistantChoicesState =
    result?.key === key ? result.state : { status: "loading" };
  return {
    state,
    retry: () => setAttempt((value) => value + 1),
  };
}
