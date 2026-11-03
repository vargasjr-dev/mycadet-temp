import { readInjectedConfig } from "@/lib/injected-config";

import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export function isCadetCloudRemote(): boolean {
  return readInjectedConfig()?.remote === "cloud";
}

function nonEmptyString(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * Display name of the serving assistant, when the served remote-gateway config
 * carries one. Older served configs omit it, so callers must tolerate
 * `undefined`.
 */
export function getRemoteGatewayAssistantName(): string | undefined {
  return nonEmptyString(readInjectedConfig()?.assistantName);
}

/** Live persona name when hydrated, else the (possibly stale) name the edge injected at tunnel start. */
export function getRemoteAssistantDisplayName(): string | undefined {
  const live = useAssistantIdentityStore.getState().name?.trim();
  return live || getRemoteGatewayAssistantName();
}

/**
 * The cloud hub SPA's assistant-root URL (`<origin>/assistant`), when the
 * served remote-gateway config carries one. Older served configs omit it, so
 * callers must tolerate `undefined`.
 */
export function getRemoteGatewayHubUrl(): string | undefined {
  return nonEmptyString(readInjectedConfig()?.hubUrl);
}
