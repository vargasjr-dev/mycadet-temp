import { useEffect, useState } from "react";
import { describeError } from "./describe-error";
import { AssistantListSchema, type AssistantList } from "./resolution-contract";
import { resolveAssistant } from "./resolve-assistant";

/**
 * The chooser's request state: only what the resolution endpoint can answer
 * for a chooser, plus the transport states every request carries. The
 * single-assistant resolution arms live in the shell's flow — the chooser is
 * committed to choosing an assistant, so a ready/notReady answer reads as an
 * error card here.
 */
export type AssistantChoicesState =
  | { status: "loading" | "error" }
  | AssistantList;

/**
 * The chooser's request hook: it calls the same one resolution endpoint the
 * shell does, and it is SAME-ORIGIN by contract — `window.location.origin`,
 * like every other Cadet surface's chooser (the web dev server proxies /v1,
 * the desktop protocol handler forwards it, the edge and cloud takeovers
 * route it, and the mobile shells' native scheme handler resolves it).
 * Naming a base here would bypass the serving layer and lose its session
 * handling. The union's empty arm reads as an empty selection — the screen
 * derives its own empty state from the row count.
 */
export function useAssistantChoices() {
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify([attempt]);
  const [result, setResult] = useState<{
    key: string;
    state: AssistantChoicesState;
  }>();
  useEffect(() => {
    const controller = new AbortController();
    const settle = (state: AssistantChoicesState) => setResult({ key, state });
    settle({ status: "loading" });
    const timer = setTimeout(() => {
      console.error("Assistant list request timed out after 10s");
      controller.abort();
      settle({ status: "error" });
    }, 10_000);
    void Promise.resolve()
      .then(() => {
        if (controller.signal.aborted) {
          return;
        }
        return resolveAssistant({
          apiBaseUrl: "/",
          signal: controller.signal,
        });
      })
      .then(
        (value) => {
          if (controller.signal.aborted || value === undefined) {
            return;
          }
          clearTimeout(timer);
          // The empty arm reads as an empty selection (the screen derives
          // its own empty state from the row count); the shell-owned arms
          // (ready/notReady/unavailable) fail the chooser's contract parse
          // and land in the error state.
          const choices: unknown =
            value.status === "empty"
              ? { status: "selection", assistants: [] }
              : value;
          const parsed = AssistantListSchema.safeParse(choices);
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
            console.error(
              `Assistant list request failed: ${describeError(error)}`,
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
  }, [attempt, key]);
  const state: AssistantChoicesState =
    result?.key === key ? result.state : { status: "loading" };
  return {
    state,
    retry: () => setAttempt((value) => value + 1),
  };
}
