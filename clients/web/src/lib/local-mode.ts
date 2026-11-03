import { readInjectedConfig } from "@/lib/injected-config";

import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import type { LockfileAssistant } from "@mycadet/local-mode/contract";

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

/**
 * Whether this bundle is served by a cadet's gateway itself (a self-hosted
 * edge or a docker cadet) rather than running beside a local host or on the
 * cloud platform. The serving gateway synthesizes the single "self" assistant
 * for the chooser and owns the lockfile view. This is a topology fact —
 * distinct from the auth-scheme question (`isCadetCloudRemote`) — and it is
 * the only place the `remote` value selects a code path.
 */
export function isServedGatewayRuntime(): boolean {
  const remote = readInjectedConfig()?.remote;
  return remote === "docker" || remote === "custom";
}

export function isLocalClient(): boolean {
  // The serving host stamps the runtime truth: Cadet Cloud's served SPA
  // carries remote "cloud"; the desktop shim, dev servers, and every
  // self-hosted surface resolve to a local arm (or inject nothing at all,
  // which reads as local too).
  return readInjectedConfig()?.remote !== "cloud";
}

// ---------------------------------------------------------------------------
// Retire
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Assistant queries
// ---------------------------------------------------------------------------

/**
 * A local-kind assistant, by origin: a plain on-machine assistant the web
 * client drives through its full set of local lifecycle flows (wake, local
 * retire). Identity only — whether it currently has a reachable gateway is a
 * separate, connect-time question.
 *
 * Deliberately excludes the externally-managed container runtimes
 * (`docker`, `apple-container`), the remote self-hosted cloud (`custom`,
 * reached at its own `runtimeUrl`), and platform (`cloud`). See the
 * `KNOWN_REMOTES` taxonomy in `@mycadet/local-mode/contract`.
 */
export function isLocalAssistant(a: LockfileAssistant): boolean {
  return a.cloud === "local";
}
