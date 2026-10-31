import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

/**
 * Aim the hosting selectors at a local or cloud world.
 *
 * The hosting answer is the store's active row's `cloud` (the projection
 * normalizes it: the lockfile entry's hosting kind for lockfile rows,
 * `"cloud"` for rows absent from the lockfile). A local stamp injects the
 * config and seeds a self-hosted row for the active id; the cloud world
 * activates a row with no lockfile entry.
 */
export function setHosting(
  kind: "local" | "cloud",
  assistantId = "asst-local",
): void {
  const { assistants } = useResolvedAssistantsStore.getState();
  if (kind === "local") {
    window.__CADET_CONFIG__ = { remote: "local", assistantId };
    useResolvedAssistantsStore.setState({
      activeAssistantId: assistantId,
      assistants: [
        ...assistants.filter((a) => a.id !== assistantId && a.id !== "asst-platform"),
        { id: assistantId, cloud: "local" },
      ],
    });
  } else {
    window.__CADET_CONFIG__ = undefined;
    useResolvedAssistantsStore.setState({
      activeAssistantId: "asst-platform",
      assistants: assistants.filter((a) => a.id !== "asst-platform"),
    });
  }
}
