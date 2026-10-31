import type { LockfileAssistant, Remote } from "@mycadet/local-mode/contract";

import { useResolvedAssistantStore } from "@/stores/resolved-assistant-store";

/**
 * Aim the hosting hook at any served remote.
 *
 * The hosting answer lives on the served entry's `cloud` field: a self-hosted
 * stamp injects the config and stamps the store with the synthesized
 * self-hosted entry; the cloud world stamps a cloud entry.
 */
export function setHosting(kind: Remote, assistantId = "asst-local"): void {
  if (kind === "cloud") {
    useResolvedAssistantStore.getState().setAssistant({
      cloud: "cloud",
      assistantId: "asst-platform",
    } satisfies LockfileAssistant);
    return;
  }
  window.__CADET_CONFIG__ = { remote: kind, assistantId };
  useResolvedAssistantStore
    .getState()
    .setAssistant(servedEntry(kind, assistantId));
}

/** The minimal `LockfileAssistant` a serving host of `kind` stamps. */
function servedEntry(cloud: Remote, assistantId: string): LockfileAssistant {
  switch (cloud) {
    case "custom":
      return { cloud, assistantId, ipAddress: "127.0.0.1", port: 0 };
    case "baseten":
      return {
        cloud,
        assistantId,
        sandboxUrl: "https://sandbox.example",
        port: 0,
      };
    case "apple-container":
      return { cloud, assistantId, port: 0, mgmtSocket: "/tmpqa.sock" };
    case "docker":
    case "local":
      return { cloud, assistantId, port: 0 };
    case "cloud":
      return { cloud, assistantId };
  }
}
