import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

/**
 * Aim the hosting selectors at a local or cloud world.
 *
 * The hosting answer lives on the lockfile entry's remote field, not any
 * resolution state: a local stamp injects the config (whose synthesized
 * entry is self-hosted) and points the store's active id at it; the cloud
 * world synthesizes no entry for the active row, so the row reads
 * cloud-hosted.
 */
export function setHosting(
  kind: "local" | "cloud",
  assistantId = "asst-local",
): void {
  if (kind === "local") {
    window.__CADET_CONFIG__ = { remote: "local", assistantId };
    useResolvedAssistantsStore.setState({ activeAssistantId: assistantId });
  } else {
    useResolvedAssistantsStore.setState({ activeAssistantId: "asst-platform" });
  }
}
