import { readInjectedConfig } from "@/lib/injected-config";

import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import type { Lockfile, LockfileAssistant } from "@mycadet/local-mode/contract";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Served assistant
// ---------------------------------------------------------------------------

const EMPTY_LOCKFILE: Lockfile = { assistants: [], activeAssistant: null };

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

/**
 * The assistant identity stamped by the serving host: one entry mirroring the
 * stamped remote. The host owns routing — the renderer holds no transport URL
 * and classifies nothing as paired — so the entry carries only what identity
 * readers need. A baseten stamp has no serving fields in the injected config,
 * so it falls back to the local default the contract's own preprocessor uses.
 */
export function getServedLockfile(): Lockfile {
  const config = readInjectedConfig();
  const assistantId = nonEmptyString(config?.assistantId);
  if (isCadetCloudRemote() || !assistantId) {
    return { ...EMPTY_LOCKFILE };
  }
  const remote = config?.remote ?? "local";
  const base = {
    assistantId,
    name: nonEmptyString(config?.assistantName) ?? "Local Assistant",
    hatchedAt: "1970-01-01T00:00:00.000Z",
  };
  const localish = (
    cloud: "local" | "docker" | "apple-container",
  ): { cloud: "local" | "docker" | "apple-container" } extends never
    ? never
    : LockfileAssistant =>
    ({ ...base, cloud, port: 0, daemonPort: 0 }) as LockfileAssistant;
  const entry =
    remote === "custom"
      ? { ...base, cloud: "custom" as const, ipAddress: "127.0.0.1", port: 0 }
      : remote === "cloud"
        ? { ...base, cloud: "cloud" as const }
        : remote === "docker"
          ? localish("docker")
          : remote === "apple-container"
            ? localish("apple-container")
            : localish("local");
  return {
    assistants: [entry],
    activeAssistant: assistantId,
  };
}

// ---------------------------------------------------------------------------
// Core helpers
// ---------------------------------------------------------------------------

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

/**
 * The lockfile's active assistant, or — when the recorded `activeAssistant`
 * no longer resolves but exactly one assistant exists — that sole assistant.
 * Returns `undefined` when the active id is stale and the choice is ambiguous,
 * so callers fall back deliberately rather than silently binding to a
 * positional entry that may shadow the real active assistant.
 */
export function getActiveAssistant(): LockfileAssistant | undefined {
  const lf = getServedLockfile();
  const active = lf.assistants.find(
    (a) => a.assistantId === lf.activeAssistant,
  );
  if (active) {
    return active;
  }
  if (lf.assistants.length === 1) {
    return lf.assistants[0];
  }
  return undefined;
}

/**
 * The lockfile entry for a specific assistant id, if one exists.
 */
export function getLockfileAssistant(
  assistantId: string,
): LockfileAssistant | undefined {
  return getServedLockfile().assistants.find(
    (a) => a.assistantId === assistantId,
  );
}
