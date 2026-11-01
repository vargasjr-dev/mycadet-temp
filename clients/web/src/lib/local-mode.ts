import {
  getGatewayUrl,
  isLoopbackGatewayCloud,
  isUsableBaseUrl,
} from "@mycadet/local-mode/contract";
import {
  isLoopbackPublicUrl,
  isRetryablePairingReason,
} from "@mycadet/service-contracts/remote-web-pairing";

import { readInjectedConfig } from "@/lib/injected-config";

import { isPublicBaseUrlRejection } from "@/utils/pairing-address";
import {
  clearSelectedAssistantId,
  readSelectedAssistantId,
} from "@/assistant/selected-assistant-storage";
import {
  getSelfHostedIngressUrl,
  setSelfHostedConnection,
} from "@/lib/self-hosted/connection";
import { probeAssistantReadyzHost } from "@/runtime/local-mode-host";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import {
  GuardianTokenError,
  loadLockfileHost,
  pairingCancelHost,
  pairingPollHost,
  pairingStartHost,
  unpairAssistantHost,
  wakeLocalAssistantHost,
} from "@/runtime/local-mode-host";
import type { Lockfile, LockfileAssistant } from "@mycadet/local-mode/contract";
import type {
  LocalPairingFailure,
  LocalPairingPollResult,
  LocalPairingStartResult,
} from "@/runtime/local-mode-host";

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

/**
 * Drop the session state bound to the selected assistant: the raw selection
 * key (the app shell's chooser memory) and the self-hosted connection (whose
 * token slot is the only bearer custody).
 */
function clearSelectedAssistantSession(): void {
  clearSelectedAssistantId();
  setSelfHostedConnection(null);
}

/**
 * Forget a paired assistant on this device: the host removes its lockfile
 * entry and deletes its stored guardian token, never touching the remote
 * assistant (pair again anytime with `cadet connect import`). The entry
 * being removed is never the served one - it lives only in the host's
 * roster - so validation reads the host transport directly, and the raw
 * selection key (owned by the app shell's chooser) is cleared when it named
 * the removed assistant, the same way a local retire clears it.
 */
export async function removePairedAssistantFromLockfile(
  assistantId: string,
): Promise<{ ok: boolean; error?: string }> {
  let rosterKnown = true;
  try {
    rosterKnown = (await loadLockfileHost()).assistants.some(
      (a) => a.assistantId === assistantId,
    );
  } catch {
    // An unreachable host must not block the removal attempt: the host
    // validates the id itself and reports the same "not in the local list"
    // outcome through its own error.
  }
  if (!rosterKnown) {
    return { ok: false, error: "This assistant isn't in the local list." };
  }
  const wasSelected = readSelectedAssistantId() === assistantId;
  const result = await unpairAssistantHost(assistantId);
  if (!result.ok) {
    return { ok: false, error: result.error || "Failed to remove assistant." };
  }
  if (wasSelected) {
    clearSelectedAssistantSession();
  }
  return { ok: true };
}

/** Stands in when a host reports a failure with no message of its own. */
const PAIRING_FALLBACK_ERROR = "Failed to connect to that assistant.";

/**
 * Whether a refused pairing step is worth polling through, classified by the
 * shared reason table so the dialog and `cadet connect import` cannot drift.
 */
export function isRetryablePairingFailure(
  failure: LocalPairingFailure,
): boolean {
  return isRetryablePairingReason(failure.reason);
}

/**
 * Begin pairing with the assistant at `address`, a pairing link or a bare
 * `https://host` URL. The host runs the exchange and keeps the device code,
 * so what comes back is an opaque handle plus, when the address carried no
 * approved code, the code to approve on the assistant's machine.
 */
export async function startAssistantPairing(
  address: string,
): Promise<LocalPairingStartResult> {
  const result = await pairingStartHost(address);
  if (!result.ok) {
    return {
      ...result,
      error: result.error || PAIRING_FALLBACK_ERROR,
      // Runtime guard, as on the poll below: the dev-server host branch parses
      // untyped JSON, so a reason no caller has copy for degrades to the
      // host's own message rather than to no message at all.
      rejection: isPublicBaseUrlRejection(result.rejection)
        ? result.rejection
        : undefined,
    };
  }
  return result;
}

/**
 * One exchange attempt for a live pairing session.
 * `accessOnly` is true when the exchange yielded no refresh credential, so the
 * pairing's access expires and cannot renew itself.
 */
export async function pollAssistantPairing(
  handle: string,
  name?: string,
): Promise<LocalPairingPollResult> {
  const result = await pairingPollHost(handle, name);
  if (!result.ok) {
    return { ...result, error: result.error || PAIRING_FALLBACK_ERROR };
  }
  if (result.status === "pending") {
    return result;
  }
  // Runtime guard: the dev-server host branch parses untyped JSON, so a
  // malformed success degrades to a structured failure.
  if (!result.assistantId) {
    return { ok: false, error: PAIRING_FALLBACK_ERROR };
  }
  return { ...result, accessOnly: result.accessOnly === true };
}

/**
 * Forget a pending pairing session, so its code cannot be exchanged later.
 * Callers cancel on the way out (a dismissed dialog, a dead transport) and
 * have nothing to do about a failure, and a handle the host no longer knows
 * is already the outcome they wanted, so a rejecting host resolves quietly.
 */
export async function cancelAssistantPairing(handle: string): Promise<void> {
  try {
    await pairingCancelHost(handle);
  } catch {
    // Unreachable session: cancelled, spent, or the host itself is gone.
  }
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

export async function probeLocalGatewayReady(): Promise<boolean> {
  const assistant = getActiveAssistant();
  if (!assistant || !hasGatewayAddress(assistant)) {
    return false;
  }
  try {
    // Host-side probing: the serving host resolves the assistant's gateway
    // from the id in the path and dials its root `/readyz` itself — the
    // renderer never sees a port or an unscoped gateway path.
    return isReadyzResponseReady(
      await probeAssistantReadyzHost(assistant.assistantId),
    );
  } catch {
    return false;
  }
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
    // Host-side probing through the scoped readyz route: the serving host
    // resolves the gateway from the id in the path, dials its root
    // `/readyz`, and injects its own bearer.
    const readiness = await probeAssistantReadyzHost(assistant.assistantId);
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

/**
 * Classify a connect failure as something a plain `wake` can fix. A `403`
 * is a loopback-boundary refusal, a security decision wake cannot change, so
 * it surfaces as-is. Remaining failures (an unresolved port, or an
 * unreachable/stopped gateway) are what `wake` can fix by re-seeding the
 * token and restarting the assistant + gateway.
 */
function isRepairableConnectError(error: unknown): boolean {
  if (error instanceof GuardianTokenError) {
    return error.status !== 403;
  }
  return true;
}

/**
 * Retry budget for riding out a wake-restarted gateway's come-back window:
 * the just-run `wake` restarts the gateway in place, so the immediately
 * following prime races the port re-binding — the probe fails for tens of
 * seconds (port not bound yet), then answers transiently (a `503`
 * "starting"). Mutable so tests can shrink the window.
 */
export const LOCAL_GATEWAY_RESTART_RETRY = {
  attempts: 90,
  intervalMs: 1_000,
};

/** Guardian refresh `503`: the loopback gateway is unreachable or still starting. */
function isTransientGuardianTokenError(error: unknown): boolean {
  return error instanceof GuardianTokenError && error.status === 503;
}

/**
 * A `wake`-restarted gateway that hasn't finished coming back up: it refuses
 * connections (a thrown transport error) or answers `503`/`5xx`. A `403`
 * loopback-boundary refusal is terminal. An unresolved local gateway (no
 * recorded port) falls through — the just-run `wake` either established one
 * or the failure is elsewhere.
 */
function isGatewayRestartTransient(error: unknown): boolean {
  if (error instanceof GuardianTokenError) {
    return isTransientGuardianTokenError(error);
  }
  if (error instanceof UnresolvedLocalGatewayError) {
    return false;
  }
  // A thrown fetch/transport error: the gateway isn't accepting connections
  // yet as it restarts.
  return true;
}

/**
 * Prime the local gateway connection, retrying on a bounded interval while
 * the failure is a transient one (`shouldRideOut`) — the wake-restart window
 * the caller rides out. The last error propagates once the retry budget is
 * spent or the failure is not a ride-out-able one, so the existing
 * connect-error classification is preserved.
 */
async function primeLocalGatewayWithRestartRideout(
  target: LockfileAssistant | undefined,
  shouldRideOut: (error: unknown) => boolean,
): Promise<void> {
  const { attempts, intervalMs } = LOCAL_GATEWAY_RESTART_RETRY;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await primeLocalGatewayConnection(target);
      return;
    } catch (error) {
      if (attempt >= attempts || !shouldRideOut(error)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}

/**
 * Prime the local gateway connection, transparently repairing the assistant in
 * place when the prime fails for a reason a plain `wake` can fix.
 *
 * This mirrors the native client's bootstrap, which revives a stopped or
 * unresolved local assistant before the failure ever reaches the user. A
 * loaded web bundle guarantees a cadet gateway that started — soon the bundle
 * is served by the gateway itself — so the first pass is a single prime. A
 * repairable failure (unreachable gateway, unresolved port) runs a plain
 * `wake` (restarts the assistant + gateway, leaving the assistant's data and
 * identity untouched), then primes again, riding out the wake-restart window.
 * A non-repairable failure, a wake that itself fails, or a still-failing
 * retry propagate the original error so the existing connect-error UI
 * surfaces it unchanged.
 */
export async function primeLocalGatewayConnectionWithRepair(
  target?: LockfileAssistant,
): Promise<void> {
  const assistant = target ?? getActiveAssistant();
  try {
    await primeLocalGatewayConnection(assistant);
    return;
  } catch (error) {
    // Wake operates only on plain local assistants: spawning it for a
    // non-local target would burn time on a refusal, so their failures
    // propagate untouched. The recovery decision is remote-agnostic — the
    // local-topology check is the whole gate.
    if (!assistant || !isLocalAssistant(assistant)) {
      throw error;
    }
    if (!isRepairableConnectError(error)) {
      throw error;
    }
    const assistantId = assistant.assistantId;
    const repair = await wakeLocalAssistantHost(assistantId);
    if (!repair.ok) {
      throw error;
    }
    // Wake restarts the assistant + gateway, so the retry races the gateway
    // coming back up. A single prime here fails while it is still starting and
    // the connect dead-ends to the recovery controls. Ride out that restart
    // window instead, so a persisted local assistant reconnects on its own.
    // The served entry is all the renderer ever knows (the host owns the
    // roster): the wake's effect shows up in the host-routed probe, not in
    // any renderer-visible field.
    await primeLocalGatewayWithRestartRideout(
      assistant,
      isGatewayRestartTransient,
    );
  }
}
