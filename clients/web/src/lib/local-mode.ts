import {
  getLoopbackGatewayPort,
  isLoopbackGatewayCloud,
  isUsableRuntimeUrl,
} from "@mycadet/local-mode/contract";
import {
  isLoopbackPublicUrl,
  isRetryablePairingReason,
} from "@mycadet/service-contracts/remote-web-pairing";

import { readInjectedConfig } from "@/lib/injected-config";

import { getLocalSetting, setLocalSetting } from "@/utils/local-settings";
import { isPublicBaseUrlRejection } from "@/utils/pairing-address";
import {
  clearSelectedAssistantId,
  readSelectedAssistantId,
} from "@/assistant/selected-assistant-storage";
import {
  getSelfHostedActorToken,
  getSelfHostedIngressUrl,
  setSelfHostedConnection,
} from "@/lib/self-hosted/connection";
import { probeAssistantReadyzHost } from "@/runtime/local-mode-host";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useLockfileStore } from "@/stores/lockfile-store";
import {
  GuardianTokenError,
  loadLockfileHost,
  pairingCancelHost,
  pairingPollHost,
  pairingStartHost,
  parseLockfile,
  retireLocalAssistantHost,
  unpairAssistantHost,
  wakeLocalAssistantHost,
} from "@/runtime/local-mode-host";
import type {
  Lockfile,
  LockfileAssistant,
  LocalAssistantResources,
  LocalPairingFailure,
  LocalPairingPollResult,
  LocalPairingStartResult,
  LocalRetireResult,
} from "@/runtime/local-mode-host";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// The lockfile shape is the transport contract shared by the Electron IPC and
// dev-server branches, so the seam owns it; re-exported here for the renderer
// features that read and model assistants.
export type {
  Lockfile,
  LockfileAssistant,
  LocalAssistantResources,
  LocalRetireResult,
};

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

// The cache lives in the lockfile store so React consumers can subscribe to
// changes; this module owns the transport and is the only writer.
const getCachedLockfile = (): Lockfile | null =>
  useLockfileStore.getState().lockfile;
const setCachedLockfile = (data: Lockfile, committed = true): void =>
  useLockfileStore.getState().setLockfile(data, committed);

const EMPTY_LOCKFILE: Lockfile = { assistants: [], activeAssistant: null };

const LOCKFILE_STORAGE_KEY = "cadet:local:lockfile";

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

function getRemoteGatewayLockfile(): Lockfile {
  return {
    assistants: [
      {
        assistantId: "self",
        name: getRemoteGatewayAssistantName() ?? "Local Assistant",
        cloud: "local",
        runtimeUrl: window.location.origin,
        hatchedAt: "1970-01-01T00:00:00.000Z",
        resources: { gatewayPort: 0, daemonPort: 0 },
      },
    ],
    activeAssistant: "self",
  };
}

// Advance the in-memory cache and mirror the lockfile to persisted storage in
// one step. The mirror lets the synchronous `getLockfile()` hydrate from
// storage on a cold read before the host transport has responded.
const commitLockfile = (data: Lockfile): void => {
  setCachedLockfile(data);
  setLocalSetting(LOCKFILE_STORAGE_KEY, JSON.stringify(data));
  // Only reconcile against a lockfile from a successful host read/write — never
  // the transient empty fallback in `getLockfile`, which would wrongly drop a
  // valid selection on a boot/read failure.
  reconcileSelectedAssistant();
};

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

export async function loadLockfile(): Promise<Lockfile> {
  if (isServedGatewayRuntime()) {
    const lockfile = getRemoteGatewayLockfile();
    commitLockfile(lockfile);
    return lockfile;
  }

  // A cloud-hosted cadet has no local-mode host: the bundle is served by
  // Cadet Cloud, so a local lockfile fetch would land on its web app
  // instead of a local daemon. Commit an empty lockfile without fetching —
  // the assistant list comes from the cloud API, and stale persisted local
  // entries must not leak into a cloud session.
  if (isCadetCloudRemote()) {
    const empty = { ...EMPTY_LOCKFILE };
    setCachedLockfile(empty);
    return empty;
  }

  try {
    const data = await loadLockfileHost();
    commitLockfile(data);
    return data;
  } catch {
    // Host read failed — keep whatever we already have (the in-memory cache,
    // then the persisted mirror) rather than clobbering it with an empty
    // lockfile that subscribers would mistake for "no assistants".
    return getLockfile();
  }
}

export function getLockfile(): Lockfile {
  if (isServedGatewayRuntime()) {
    const lockfile = getRemoteGatewayLockfile();
    setCachedLockfile(lockfile);
    return lockfile;
  }

  const cached = getCachedLockfile();
  if (cached) {
    return cached;
  }

  const stored = getLocalSetting(LOCKFILE_STORAGE_KEY, "");
  if (stored) {
    try {
      const parsed = parseLockfile(JSON.parse(stored));
      setCachedLockfile(parsed);
      return parsed;
    } catch {
      // Unparseable JSON -- fall through to empty lockfile. (A structurally
      // invalid lockfile does not throw: parseLockfile salvages what it can.)
    }
  }

  // Not committed: this is a "nothing loaded yet" placeholder, not evidence
  // that the assistants are gone — reconciling subscribers must ignore it.
  const empty = { ...EMPTY_LOCKFILE };
  setCachedLockfile(empty, false);
  return empty;
}

/**
 * Drop the session state bound to the selected assistant: the raw selection
 * key (no store import here, that would cycle; the reactive slice reconciles
 * via `setFromLockfile` on the next lockfile commit/load) and the
 * self-hosted connection (whose token slot is the only bearer custody).
 */
function clearSelectedAssistantSession(): void {
  clearSelectedAssistantId();
  setSelfHostedConnection(null);
}

/**
 * Forget a paired assistant on this device: the host removes its lockfile
 * entry and deletes its stored guardian token, never touching the remote
 * assistant (pair again anytime with `cadet connect import`). When the
 * removed entry is the effective selection, the session residue (selection
 * key, gateway token, self-hosted connection) is cleared the same way a
 * local retire clears it, so the next connect starts clean.
 */
export async function removePairedAssistantFromLockfile(
  assistantId: string,
): Promise<{ ok: boolean; error?: string }> {
  const entry = getLockfileAssistant(assistantId);
  if (!entry) {
    return { ok: false, error: "This assistant isn't in the local list." };
  }
  const wasSelected = getSelectedAssistant()?.assistantId === assistantId;
  const result = await unpairAssistantHost(assistantId);
  if (!result.ok) {
    return { ok: false, error: result.error || "Failed to remove assistant." };
  }
  if (wasSelected) {
    clearSelectedAssistantSession();
  }
  commitLockfile(result.lockfile);
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
 * One exchange attempt for a live pairing session. On `imported` the lockfile
 * is reloaded so subscribers (the resolved-assistants store) pick up the new
 * entry, the write counterpart of {@link removePairedAssistantFromLockfile}.
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
  await loadLockfile();
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

/**
 * Retire a local assistant, then clear its selection, gateway token, and
 * self-hosted connection and reload the lockfile. On failure the local state
 * is left untouched and the error is returned for the caller to surface.
 */
export async function retireLocalAssistant(
  assistantId: string,
): Promise<LocalRetireResult> {
  const result = await retireLocalAssistantHost(assistantId);
  if (result.ok) {
    clearSelectedAssistantSession();
    await loadLockfile();
  }
  return result;
}

// ---------------------------------------------------------------------------
// Assistant queries
// ---------------------------------------------------------------------------

/**
 * Whether any assistant is known locally. Reads the in-memory lockfile cache,
 * so it stays synchronous on every host — no transport hop required.
 */
export function hasAssistants(): boolean {
  return getLockfile().assistants.length > 0;
}

/**
 * A local-kind assistant, by origin: a plain on-machine assistant the web
 * client drives through its full set of local lifecycle flows (wake, local
 * retire). Identity only — whether it currently has a reachable gateway is a
 * separate, connect-time question (see `hasLocalGateway`).
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
export function isCliWakeableAssistant(assistantId: string): boolean {
  const entry = getLockfile().assistants.find(
    (a) => a.assistantId === assistantId,
  );
  return !!entry && isLocalAssistant(entry);
}

export function getLocalAssistants(): LockfileAssistant[] {
  return getLockfile().assistants.filter(isLocalAssistant);
}

export function getCloudAssistants(): LockfileAssistant[] {
  return getLockfile().assistants.filter(isCloudAssistant);
}

/**
 * The lockfile's active assistant, or — when the recorded `activeAssistant`
 * no longer resolves but exactly one assistant exists — that sole assistant.
 * Returns `undefined` when the active id is stale and the choice is ambiguous,
 * so callers fall back deliberately rather than silently binding to a
 * positional entry that may shadow the real active assistant.
 */
export function getActiveAssistant(): LockfileAssistant | undefined {
  const lf = getLockfile();
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

export function getSelectedAssistant(): LockfileAssistant | undefined {
  const selectedId = readSelectedAssistantId();
  if (selectedId) {
    const found = getLockfile().assistants.find(
      (a) => a.assistantId === selectedId,
    );
    if (found) {
      return found;
    }
  }
  return getActiveAssistant();
}

/** The lockfile entry for a specific assistant id, if one exists. */
export function getLockfileAssistant(
  assistantId: string,
): LockfileAssistant | undefined {
  return getLockfile().assistants.find((a) => a.assistantId === assistantId);
}

/**
 * React subscription to one lockfile entry's `name`: `undefined` while the
 * lockfile hasn't hydrated or the id has no entry, `null` when the entry
 * exists but is unnamed. Distinguishing absence from an unnamed entry lets
 * effects depending on this value re-fire even when the appearing entry
 * carries no name.
 */
export function useLockfileAssistantName(
  assistantId: string | null,
): string | null | undefined {
  return useLockfileStore((s) => {
    if (assistantId === null) {
      return undefined;
    }
    const entry = s.lockfile?.assistants.find(
      (a) => a.assistantId === assistantId,
    );
    return entry === undefined ? undefined : (entry.name ?? null);
  });
}

/**
 * Reconcile the selection key against the lockfile registry: if the selected id
 * no longer names a lockfile entry, clear it so `getSelectedAssistant` falls
 * back to `getActiveAssistant`. The store's own reconcile (on `setFromLockfile`)
 * covers the reactive slice; this keeps the raw key honest on the synchronous
 * `commitLockfile` path, including the pre-React-mount gateway-auth boot.
 */
export function reconcileSelectedAssistant(): void {
  const selectedId = readSelectedAssistantId();
  if (!selectedId) {
    return;
  }
  const present = getLockfile().assistants.some(
    (a) => a.assistantId === selectedId,
  );
  if (!present) {
    clearSelectedAssistantId();
  }
}

// ---------------------------------------------------------------------------
// Gateway predicates
// ---------------------------------------------------------------------------
/**
 * Whether the entry's gateway lives on another machine (a connect import):
 * a loopback-gateway cloud whose `runtimeUrl` points off this machine.
 */
function isRemoteGatewayEntry(entry: LockfileAssistant): boolean {
  return (
    isLoopbackGatewayCloud(entry.cloud) &&
    isUsableRuntimeUrl(entry.runtimeUrl) &&
    !isLoopbackPublicUrl(entry.runtimeUrl)
  );
}

function expectsLocalGateway(
  assistant: LockfileAssistant | undefined,
): assistant is LockfileAssistant {
  return (
    !!assistant &&
    isLocalClient() &&
    !isServedGatewayRuntime() &&
    isLoopbackGatewayCloud(assistant.cloud) &&
    !isRemoteGatewayEntry(assistant)
  );
}

/**
 * Whether the given assistant (default: the selected one) reaches this
 * runtime over a resolvable local gateway: a local-kind assistant in local
 * (non-remote-gateway) mode with a recorded loopback port. The host owns
 * everything URL-shaped — the scoped data plane is plain same-origin `/v1`.
 */
export function hasLocalGateway(
  assistant: LockfileAssistant | undefined = getSelectedAssistant(),
): boolean {
  if (!expectsLocalGateway(assistant)) {
    return false;
  }
  return getLoopbackGatewayPort(assistant) != null;
}

/**
 * Whether this runtime should reach `assistant` at a remote paired gateway: a
 * loopback-gateway entry whose `runtimeUrl` points off this machine, in local
 * (non-remote-gateway) mode.
 * Whether the entry records a usable `runtimeUrl` is a separate question
 * answered by `hasPairedGateway`. Deliberately not a type predicate: its
 * false branch must not narrow `assistant` (a local entry also lands there).
 */
export function expectsPairedGateway(assistant: LockfileAssistant): boolean {
  return (
    isLocalClient() &&
    !isServedGatewayRuntime() &&
    isRemoteGatewayEntry(assistant)
  );
}

/**
 * Whether the entry is a paired assistant this runtime reaches through the
 * host's forward: paired in local (non-remote-gateway) mode with a recorded
 * absolute http(s) `runtimeUrl` for the host to resolve. The renderer never
 * fetches the remote origin itself — the serving host forwards and injects
 * the guardian bearer; the scoped data plane is plain same-origin `/v1`.
 */
export function hasPairedGateway(
  assistant: LockfileAssistant | undefined,
): boolean {
  return (
    !!assistant &&
    expectsPairedGateway(assistant) &&
    isUsableRuntimeUrl(assistant.runtimeUrl)
  );
}

/**
 * Whether this client's data plane is a gateway: the served-gateway browser,
 * or a local client whose selected assistant carries a local or paired
 * gateway. The session vision's device side — such clients authenticate by
 * device (the trusted host's injected bearer, or the pairing slot's token),
 * never by user session.
 */
export function hasGatewayAssistant(): boolean {
  if (isServedGatewayRuntime()) {
    return true;
  }
  if (!isLocalClient()) {
    return false;
  }
  const assistant = getSelectedAssistant();
  return hasLocalGateway(assistant) || hasPairedGateway(assistant);
}

/**
 * Whether the gateway session is live: on a served runtime the paired
 * browser's device credential (the connection slot's token); on a local
 * client the trusted host owns bearer custody, so topology decides.
 */
export function isGatewaySessionLive(): boolean {
  if (!hasGatewayAssistant()) {
    return false;
  }
  if (!isServedGatewayRuntime()) {
    const selectedAssistant = getSelectedAssistant();
    if (hasPairedGateway(selectedAssistant)) {
      // The paired prime seeds the shared same-origin data-plane slot.
      return getSelfHostedIngressUrl() != null;
    }
    // The local signal is topology — a resolvable gateway — not token
    // presence: the trusted host owns bearer custody in this mode.
    return hasLocalGateway(selectedAssistant);
  }
  return getSelfHostedActorToken() !== null;
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
  const assistant = getSelectedAssistant();
  if (!assistant || !expectsLocalGateway(assistant)) {
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
 * A paired assistant records no usable `runtimeUrl`, so there is no remote
 * gateway to reach. Deliberately not {@link UnresolvedLocalGatewayError}: that
 * one routes to the wake-recovery dialog in the chooser, and `wake` refuses
 * paired entries (re-pairing from the source machine is the fix).
 */
export class UnresolvedPairedGatewayError extends Error {
  constructor(assistantId: string) {
    super(`Paired assistant ${assistantId} has no usable runtimeUrl`);
    this.name = "UnresolvedPairedGatewayError";
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
  const assistant = target ?? getSelectedAssistant();
  if (!assistant) {
    return;
  }
  if (expectsPairedGateway(assistant)) {
    if (!hasPairedGateway(assistant)) {
      throw new UnresolvedPairedGatewayError(assistant.assistantId);
    }
  } else if (!hasLocalGateway(assistant)) {
    // A local assistant we recognize but can't resolve a gateway for (no
    // port) is recoverable by waking it — surface that instead of
    // silently leaving the session unconnected. Non-local / non-local-
    // mode cases stay no-ops.
    if (expectsLocalGateway(assistant)) {
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
 * Retry budget for riding out the local gateway's startup window. On reboot the
 * gateway (a macOS Login Item) restarts concurrently with the desktop app, and
 * a `wake` restarts it in place. In both cases the host-routed readyz probe
 * fails for tens of seconds (port not bound yet), then answers transiently (a
 * `503` "starting"). A single prime races that window and dead-ends to the
 * recovery controls even though the gateway becomes usable on its own.
 * Mutable so tests can shrink the window.
 */
export const LOCAL_GATEWAY_STARTUP_RETRY = {
  attempts: 90,
  intervalMs: 1_000,
};

/** Guardian refresh `503`: the loopback gateway is unreachable or still starting. */
function isTransientGuardianTokenError(error: unknown): boolean {
  return error instanceof GuardianTokenError && error.status === 503;
}

/**
 * A local loopback gateway that is still coming up: a thrown transport error
 * (Login Item has not bound the port yet) or a `503`/`5xx` "starting" probe.
 * These heal on their own, so boot and the pre-wake connect path ride them
 * out instead of spawning `wake`.
 *
 * A `403` loopback-boundary refusal is terminal. An unresolved local gateway
 * (no recorded port) needs `wake` to establish one. Paired/remote failures
 * are never ridden out: waiting cannot fix a machine this device does not
 * start.
 */
function isGatewayStillStarting(
  error: unknown,
  target: LockfileAssistant | undefined,
): boolean {
  const assistant = target ?? getSelectedAssistant();
  if (!assistant || !expectsLocalGateway(assistant)) {
    return false;
  }
  if (error instanceof UnresolvedLocalGatewayError) {
    return false;
  }
  if (error instanceof GuardianTokenError) {
    return isTransientGuardianTokenError(error);
  }
  // Thrown fetch/transport error: the loopback port is not accepting
  // connections yet.
  return true;
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
 * Prime the local gateway connection, retrying on a bounded interval while the
 * failure is a transient startup condition (`shouldRideOut`). Rides out the
 * local gateway's startup window without spawning anything: the plain prime
 * only reads the on-disk guardian token and mints a gateway session, so it
 * respects the "app launch never spawns assistant processes" boot contract. The
 * last error propagates once the retry budget is spent or the failure is not a
 * ride-out-able one, so the existing connect-error classification is preserved.
 */
async function primeLocalGatewayWithStartupRideout(
  target: LockfileAssistant | undefined,
  shouldRideOut: (error: unknown) => boolean,
): Promise<void> {
  const { attempts, intervalMs } = LOCAL_GATEWAY_STARTUP_RETRY;
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
 * Boot restore path: prime the selected local assistant's gateway connection,
 * riding out the gateway's startup window ({@link isGatewayStillStarting}).
 * Unlike the interactive {@link primeLocalGatewayConnectionWithRepair}, this
 * never `wake`s: app launch must not spawn assistant processes. An
 * unresolved port or a `403` falls through to the chooser. A `503` or
 * transport failure rides the budget; if it is still failing after that, the
 * chooser's connect-with-repair path handles it.
 */
export async function primeLocalGatewayConnectionWithStartupRetry(
  target?: LockfileAssistant,
): Promise<void> {
  await primeLocalGatewayWithStartupRideout(target, (error) =>
    isGatewayStillStarting(error, target),
  );
}

/**
 * Prime the local gateway connection, transparently repairing the assistant in
 * place when a startup ride-out still fails for a reason a plain `wake` can
 * fix.
 *
 * This mirrors the native client's bootstrap, which revives a stopped or
 * unresolved local assistant before the failure ever reaches the user. The
 * first pass rides out {@link isGatewayStillStarting} without waking, so a
 * Login Item that is still binding its port is not restarted. A remaining
 * repairable failure (unreachable gateway, unresolved port) runs a plain
 * `wake` (restarts the assistant + gateway, leaving the assistant's data and
 * identity untouched), then primes again. A non-repairable failure, a wake
 * that itself fails, or a still-failing retry propagate the original error
 * so the existing connect-error UI surfaces it unchanged.
 */
export async function primeLocalGatewayConnectionWithRepair(
  target?: LockfileAssistant,
): Promise<void> {
  const assistant = target ?? getSelectedAssistant();
  try {
    await primeLocalGatewayWithStartupRideout(assistant, (error) =>
      isGatewayStillStarting(error, assistant),
    );
    return;
  } catch (error) {
    // Wake operates only on plain local assistants (see
    // `isCliWakeableAssistant`): spawning it for a paired or otherwise
    // non-local target would burn time on a refusal, so their failures
    // propagate untouched. Paired-ness derives from topology (#484), so the
    // cloud==="local" check alone no longer excludes a connect import.
    if (
      !assistant ||
      !isLocalAssistant(assistant) ||
      isRemoteGatewayEntry(assistant)
    ) {
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
    // Wake may have established resources the renderer hadn't recorded (a legacy
    // entry's gateway port). Reload so the retry resolves the fresh gateway.
    const lockfile = await loadLockfile();
    const refreshed = lockfile.assistants.find(
      (a) => a.assistantId === assistantId,
    );
    // Wake restarts the assistant + gateway, so the retry races the gateway
    // coming back up. A single prime here fails while it is still starting and
    // the connect dead-ends to the recovery controls. Ride out that restart
    // window instead, so a persisted local assistant reconnects on its own.
    await primeLocalGatewayWithStartupRideout(
      refreshed ?? assistant,
      isGatewayRestartTransient,
    );
  }
}
