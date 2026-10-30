import type { Remote } from "@mycadet/local-mode/contract";

import { getLockfileAssistant } from "@/lib/local-mode";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useAssistantResolution } from "@/assistant/queries";
import { readInjectedConfig } from "@/lib/injected-config";

/**
 * The active assistant's remote. The answer is the lockfile entry's
 * `cloud` field — the hosting kind recorded when the assistant was
 * hatched or paired. Rows absent from the lockfile exist only in the
 * cloud-served world, so they answer `"cloud"`. Outside an active
 * resolution (boot, initializing, retired) the injected config's
 * serving topology is the best available answer; by the time the web
 * bundle loads the assistant is already resolved, so there is no
 * resolving answer.
 */
export function useAssistantHosting(): Remote {
  const { state } = useAssistantResolution();
  const activeId = useResolvedAssistantsStore((s) => s.activeAssistantId);
  if (state.kind === "active") {
    const entry = activeId ? getLockfileAssistant(activeId) : undefined;
    if (entry) {
      return entry.cloud;
    }
    return "cloud";
  }
  return readInjectedConfig()?.remote ?? "local";
}

/** The active assistant's remote is "cloud". */
export function useActiveAssistantIsCloudHosted(): boolean {
  const { state } = useAssistantResolution();
  const hosting = useAssistantHosting();
  return state.kind === "active" && hosting === "cloud";
}

/** The active assistant's remote is one of the self-hosted ones. */
export function useActiveAssistantIsSelfHosted(): boolean {
  const { state } = useAssistantResolution();
  const hosting = useAssistantHosting();
  return state.kind === "active" && hosting !== "cloud";
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
