import {
  getGatewayUrl,
  isLoopbackGatewayCloud,
  isUsableBaseUrl,
} from "@mycadet/local-mode/contract";
import { isLoopbackPublicUrl } from "@mycadet/service-contracts/remote-web-pairing";

import { readInjectedConfig } from "@/lib/injected-config";

import {
  getSelfHostedIngressUrl,
  setSelfHostedConnection,
} from "@/lib/self-hosted/connection";
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
 * Whether any assistant is known locally. Reads the in-memory lockfile cache,
 * so it stays synchronous on every host — no transport hop required.
 */
export function hasAssistants(): boolean {
  return getServedLockfile().assistants.length > 0;
}

/**
 * A local-kind assistant, by origin: a plain on-machine assistant the web
 * client drives through its full set of local lifecycle flows (wake, local
 * retire). Identity only — whether it currently has a reachable gateway is a
 * separate, connect-time question (see `hasGatewayAddress`).
 *
 * Deliberately excludes the externally-managed container runtimes
 * (`docker`, `apple-container`), the remote self-hosted cloud (`custom`,
 * reached at its own `runtimeUrl`), and platform (`cloud`). See the
 * `KNOWN_REMOTES` taxonomy in `@mycadet/local-mode/contract`.
 */
export function isLocalAssistant(a: LockfileAssistant): boolean {
  return a.cloud === "local";
}

export function isCloudAssistant(a: LockfileAssistant): boolean {
  return a.cloud === "cloud";
}

/**
 * Whether `cadet wake` can start or repair the assistant with this id. Wake
 * operates only on plain local assistants (the {@link isLocalAssistant} set) —
 * it refuses Docker and apple-container entries — so the "Wake up" and
 * guardian-repair affordances are limited to them. A missing gateway port does
 * NOT disqualify: wake is what (re)establishes it.
 */

export function getLocalAssistants(): LockfileAssistant[] {
  return getServedLockfile().assistants.filter(isLocalAssistant);
}

export function getCloudAssistants(): LockfileAssistant[] {
  return getServedLockfile().assistants.filter(isCloudAssistant);
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

/**
 * Whether the entry carries a gateway address this runtime's host can
 * resolve: a recorded loopback port for a local assistant, or a usable
 * non-loopback recorded address for a custom remote. Pairs and locals ask
 * the same question — the serving host resolves whatever the entry records
 * on its id-keyed forward; the renderer never fetches a remote origin
 * itself (the host injects the guardian bearer; the scoped data plane is
 * plain same-origin `/v1`).
 */
export function hasGatewayAddress(
  assistant: LockfileAssistant | undefined = getActiveAssistant(),
): boolean {
  if (!assistant || !isLocalClient() || isServedGatewayRuntime()) {
    return false;
  }
  if (isLoopbackGatewayCloud(assistant.cloud)) {
    return ("port" in assistant ? assistant.port : undefined) != null;
  }
  if (assistant.cloud === "custom") {
    const gatewayUrl = getGatewayUrl(assistant);
    return isUsableBaseUrl(gatewayUrl) && !isLoopbackPublicUrl(gatewayUrl);
  }
  return false;
}

/**
 * Whether a readyz body reports ready: the gateway answers `status: "ok"`
 * with no `ready: false`.
 */
function isReadyzResponseReady(body: unknown): boolean {
  if (body === null || typeof body !== "object") {
    return false;
  }
  const readiness = body as { status?: unknown; ready?: unknown };
  return (
    readiness.status === "ok" &&
    (readiness.ready === undefined || readiness.ready === true)
  );
}

// ---------------------------------------------------------------------------
// Gateway connection setup
// ---------------------------------------------------------------------------

/**
 * A local assistant has no resolvable local gateway — e.g. a legacy/migrated
 * entry whose gateway port was never recorded. Recoverable by waking it (the
 * CLI/daemon establishes the daemon + gateway and records the port), so connect
 * flows treat it as a repairable connect error rather than a silent dead end.
 */
export class UnresolvedLocalGatewayError extends Error {
  constructor(assistantId: string) {
    super(`Local assistant ${assistantId} has no resolved gateway`);
    this.name = "UnresolvedLocalGatewayError";
  }
}

/**
 * Prime the self-hosted connection for the given local or paired assistant
 * (default: the selected one). Both arms prove the gateway is reachable by
 * probing the host-routed readyz route, then seed the shared same-origin
 * slot with the bare page origin and no bearer: the trusted host mints and
 * injects the gateway bearer on its id-keyed forward, so the renderer holds
 * no credential. Passing `target` lets connect flows prime the new
 * assistant before the selection write becomes observable.
 */
export async function primeLocalGatewayConnection(
  target?: LockfileAssistant,
): Promise<void> {
  const assistant = target ?? getActiveAssistant();
  if (!assistant) {
    return;
  }
  if (!hasGatewayAddress(assistant)) {
    // A loopback-cloud assistant we recognize but can't resolve a gateway
    // for (no port) is recoverable by waking it — surface that instead of
    // silently leaving the session unconnected. Cloud/platform cases stay
    // no-ops; a custom remote's address is user-edited, not wake-fixed.
    if (isLoopbackGatewayCloud(assistant.cloud)) {
      throw new UnresolvedLocalGatewayError(assistant.assistantId);
    }
    return;
  }
  // A request through the host's id-keyed proxy forces the trusted host to
  // resolve the gateway and proves it is reachable. The renderer sends no
  // bearer — the trusted host mints and injects its own on the data plane.
  // A connection to this same gateway stays live while the probe is in
  // flight (a re-prime must not open a window in which requests fall
  // through to the cloud and gateway-auth predicates read false) and is
  // dropped only if the probe fails, so a failed prime never leaves the app
  // believing it is connected. The slot carries the bare page origin: the
  // scoped data plane is plain same-origin /v1, routed by the host through
  // the id in the path. The prime also clears credentials persisted by
  // older clients that placed gateway tokens in the gateway-session cache.
  try {
    // Probing through the scoped readyz route: the serving host resolves
    // the gateway from the id in the path, dials its root `/readyz`, and
    // injects its own bearer.
    const res = await fetch(
      `/v1/assistants/${encodeURIComponent(assistant.assistantId)}/readyz`,
    );
    const readiness = res.ok
      ? await res.json().catch(() => null)
      : new Error(
          (await res.text()) || `Gateway request failed: ${res.status}`,
        );
    if (readiness instanceof Error) {
      throw readiness;
    }
    if (!isReadyzResponseReady(readiness)) {
      throw new Error("Assistant is not ready");
    }
  } catch (error) {
    // The slot no longer encodes which assistant primed it (every local/
    // paired prime carries the same bare origin), so a failed probe clears
    // any same-origin slot — a connect flow re-primes on retry.
    if (getSelfHostedIngressUrl() === window.location.origin) {
      setSelfHostedConnection(null);
    }
    throw error;
  }
  setSelfHostedConnection({
    url: window.location.origin,
    token: null,
  });
}
