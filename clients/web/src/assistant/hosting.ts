import type { Remote } from "@mycadet/local-mode/contract";

import { useAssistantResolution } from "@/assistant/queries";
import { readInjectedConfig } from "@/lib/injected-config";

/** The active assistant's remote is "cloud". */
export function useActiveAssistantIsCloudHosted(): boolean {
  const { state } = useAssistantResolution();
  return state.kind === "active" && !state.isLocal;
}

/** The assistant lifecycle is mid-operation (boot, restart, retirement). */
export function useActiveAssistantLifecycleIsLoading(): boolean {
  const { state } = useAssistantResolution();
  return (
    state.kind === "loading" ||
    state.kind === "initializing" ||
    state.kind === "cleaning_up"
  );
}

/** The active assistant's remote is one of the self-hosted ones. */
export function useActiveAssistantIsSelfHosted(): boolean {
  const { state } = useAssistantResolution();
  return (
    state.kind === "self_hosted" || (state.kind === "active" && state.isLocal)
  );
}

/**
 * The active assistant's remote. A cloud-hosted resolution answers
 * `"cloud"`; everything else answers with the serving topology from the
 * injected config. By the time the web bundle loads the assistant is
 * already resolved, so there is no resolving answer.
 */
export function useAssistantHosting(): Remote {
  const { state } = useAssistantResolution();
  if (state.kind === "active" && !state.isLocal) {
    return "cloud";
  }
  return readInjectedConfig()?.remote ?? "local";
}
