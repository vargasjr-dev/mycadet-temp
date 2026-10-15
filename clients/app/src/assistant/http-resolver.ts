import type { ResolveAssistant } from "./resolution-contract";

/** The host endpoint returns the shared assistant-resolution contract. */
export function createHttpAssistantResolver(
  endpoint: string,
  origin: string,
): ResolveAssistant {
  return async ({ assistantId, signal }) => {
    if (!endpoint) {
      throw new Error("Configure the host's assistant resolution endpoint.");
    }
    const url = new URL(endpoint, origin);
    if (assistantId) {
      url.searchParams.set("assistantId", assistantId);
    }
    const response = await fetch(url, { signal, credentials: "same-origin" });
    if (response.status === 401) {
      return { status: "unauthenticated" };
    }
    if (!response.ok) {
      throw new Error(`Assistant resolution failed: ${response.status}`);
    }
    return response.json();
  };
}
