import { useResolvedAssistantStore } from "@/stores/resolved-assistant-store";

/**
 * Aim the hosting hook at a local or cloud world.
 *
 * The hosting answer lives on the served entry's `cloud` field: a local
 * stamp injects the config and stamps the store with the synthesized
 * self-hosted entry; the cloud world stamps a cloud entry.
 */
export function setHosting(
  kind: "local" | "cloud",
  assistantId = "asst-local",
): void {
  if (kind === "local") {
    window.__CADET_CONFIG__ = { remote: "local", assistantId };
    useResolvedAssistantStore.getState().setAssistant({
      cloud: "local",
      assistantId,
    });
  } else {
    useResolvedAssistantStore.getState().setAssistant({
      cloud: "cloud",
      assistantId: "asst-platform",
    });
  }
}
