import { isActiveAssistant, readLockfile } from "../lockfile";
import { stripSensitiveFields } from "../util";
import { pairingCancel, pairingPoll, pairingStart } from "../pair";
import { runDevicesList, runDevicesRevoke } from "../devices";
import { readLockfileAssistantAvatar } from "../avatar";
import { getLocalAssistantStatus } from "../status";
import { runHatch } from "../hatch";
import { runUpgrade, type UpgradeOptions } from "../upgrade";
import { unpairAssistant } from "../unpair";
import { getGatewayHealth } from "../daemon-readiness";
import { loopbackSafeFetch } from "../loopback-fetch";
import { getGatewayUrl, isCloudEntry } from "../lockfile-contract";
import type { LockfileAssistant } from "../lockfile-contract";
import { servedConfigFromLockfile } from "../served-config";
import { findAssistantByName } from "./lookup";
import { retireAssistant } from "./retire";
import { sleepAssistant } from "./sleep";
import { wakeAssistant } from "./wake";

/**
 * The operator ROUTE TABLE: the host-served operations — the headless
 * lifecycle cores the serving host (Electron `app://` handler, Vite dev
 * middleware) mounts before the gateway data-plane planner. One entry per
 * operation; today that is the assistant resolution, retire, sleep, wake,
 * unpair, upgrade, status, avatar, the devices routes, the remote-web
 * pairing exchange, the hatch, and the lockfile strip. The gateway proxy
 * itself is the LAST row (the catch-all forward) once every scoped route is
 * an operation.
 *
 * `matchOperatorRequest` is PURE in the URL — the hot path of every other
 * request never touches the lockfile. A match runs through
 * `match.route.run(match.assistantId, request)` directly: the routes import
 * the modules they need, no injection surface.
 *
 * The second argument carries the serving host's `Request` — body-carrying
 * rows (pairing, devices, hatch, upgrade) read the JSON body off it;
 * assistant-scoped rows read the decoded path id and ignore it, and the
 * credential-judging rows (the resolution) read the caller's own headers
 * off it — a verdict read host-side without them would be the host's, not
 * the caller's.
 */

export interface OperatorRoute {
  method: string;
  pattern: RegExp;
  /**
  /**
   * Answer the request. Returning null means PASS: the request is not this
   * host's to answer (unknown id, or an entry the host cannot retire) and
   * the pre-existing chain answers instead — the cloud's 404 for a stale id,
   * the data-plane forward for a platform-hosted entry. Routes whose pattern
   * has no capture group receive the empty string as `assistantId`.
   */
  run: (assistantId: string, request: Request) => Promise<Response | null>;
}

const RETIRE_PATTERN = /^\/v1\/assistants\/([^/?#]+)\/retire\/?$/;
const SLEEP_PATTERN = /^\/v1\/assistants\/([^/?#]+)\/sleep\/?$/;
const WAKE_PATTERN = /^\/v1\/assistants\/([^/?#]+)\/wake\/?$/;
const UNPAIR_PATTERN = /^\/v1\/assistants\/([^/?#]+)\/unpair\/?$/;
const UPGRADE_PATTERN = /^\/v1\/assistants\/([^/?#]+)\/upgrade\/?$/;
const STATUS_PATTERN = /^\/v1\/assistants\/([^/?#]+)\/?$/;
const AVATAR_PATTERN = /^\/v1\/assistants\/([^/?#]+)\/avatar\/get\/?$/;
const LOCKFILE_PATTERN = /^\/v1\/assistants\/$/;
const HATCH_PATTERN = /^\/v1\/assistants\/hatch\/?$/;
const DEVICES_PATTERN = /^\/v1\/devices\/?$/;
const DEVICES_REVOKE_PATTERN = /^\/v1\/devices\/revoke\/?$/;
const PAIRING_START_PATTERN = /^\/v1\/remote-web\/pairing-start\/?$/;
const PAIRING_POLL_PATTERN = /^\/v1\/remote-web\/pairing-poll\/?$/;
const PAIRING_CANCEL_PATTERN = /^\/v1\/remote-web\/pairing-cancel\/?$/;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * Buffer and parse a JSON request body. An empty body resolves to `{}` (the
 * per-field validation reports what's missing); malformed JSON resolves to
 * `null`.
 */
async function readJsonBody(
  request: Request,
): Promise<Record<string, unknown> | null> {
  const text = await request.text().catch(() => "");
  if (text.trim().length === 0) {
    return {};
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * The scoped surface's retire arm. A `DELETE` on
 * `/v1/assistants/{id}/retire/` for an entry the host can retire directly is
 * answered host-side by the retire operation, not forwarded to the entry's
 * gateway (which cannot retire itself). A bodyless 204 parses as the web
 * bundle's success null; a failure carries the operation's message as the
 * cloud error shape, so the confirmation dialog renders the same detail
 * either way.
 */
async function runRetireRoute(assistantId: string): Promise<Response | null> {
  const entry = findAssistantByName(assistantId);
  if (!entry) {
    return null;
  }
  // A platform-hosted entry is not this host's to retire: the host holds no
  // machine token for it, so the operation's cloud leg could never succeed —
  // the pre-existing chain's forward carries the bundle's session instead.
  // The host-executable set (loopback-gateway clouds, apple-container, and
  // the ssh-managed custom remote) answers here.
  if (entry.cloud === "cloud" || entry.cloud === "baseten") {
    return null;
  }
  const result = await retireAssistant(entry);
  if (result.ok) {
    return new Response(null, { status: 204 });
  }
  return json({ detail: result.error }, result.status);
}

/**
 * The scoped surface's sleep arm. A `POST` on `/v1/assistants/{id}/sleep/`
 * for an entry this host can stop (local/docker) is answered host-side —
 * a bodyless 204 parses as the web bundle's success null; a failure (an
 * active call lease, a windows shutdown) carries the operation's message
 * and status. Entries the host cannot stop pass through, and the
 * pre-existing chain answers.
 */
async function runSleepRoute(assistantId: string): Promise<Response | null> {
  const entry = findAssistantByName(assistantId);
  if (!entry) {
    return null;
  }
  const result = await sleepAssistant(entry);
  if (result.ok) {
    return new Response(null, { status: 204 });
  }
  return json({ detail: result.error }, result.status);
}

/**
 * The scoped surface's wake arm. A `POST` on `/v1/assistants/{id}/wake/`
 * for an entry this host can start is answered host-side — the
 * non-destructive repair primitive the web bundle's connect-repair rides.
 * A docker entry whose containers were never created answers 404 pointing
 * at the CLI (the recreate needs the container-create builder, still
 * CLI-side); a bodyless 204 parses as the web bundle's success.
 */
async function runWakeRoute(assistantId: string): Promise<Response | null> {
  const entry = findAssistantByName(assistantId);
  if (!entry) {
    return null;
  }
  const result = await wakeAssistant(entry);
  if (result.ok) {
    return new Response(null, { status: 204 });
  }
  return json({ detail: result.error }, result.status);
}

/**
 * The renderer-safe lockfile: the bare `/v1/assistants/` GET serves the
 * lockfile read with sensitive fields stripped — the lockfile half of the
 * renderer's local-mode seam. A query-carrying list request (the SDK's) does
 * not match this exact path and rides the data-plane chain to the
 * conductor's list route.
 */
async function runLockfileRoute(): Promise<Response> {
  const lockfile = readLockfile();
  stripSensitiveFields(lockfile);
  return json(lockfile);
}

/**
 * Provision a local assistant. Never rejects — failures resolve with
 * `{ ok: false, error }` so the renderer renders the same error UI the
 * status probe drives. The CLI owns the daemon + gateway process lifecycle:
 * a hatched local assistant runs its own daemon, and the serving host only
 * ever invokes the CLI as a subprocess.
 */
async function runHatchRoute(
  _assistantId: string,
  request: Request,
): Promise<Response> {
  const body = (await readJsonBody(request)) ?? {};
  const remote = typeof body.remote === "string" ? body.remote : undefined;
  try {
    const result = await runHatch({ remote });
    return json(
      result.ok
        ? { ok: true, assistantId: result.assistantId }
        : { ok: false, error: result.error },
    );
  } catch (err) {
    return json({ ok: false, error: (err as Error).message });
  }
}

/**
 * Forget a paired assistant (the `paired` flag): remove its lockfile entry
 * and delete its stored guardian token on this machine. Client-side only:
 * the remote assistant is never touched. An id that is not an entry on this
 * machine passes — the id-keyed proxy resolves the rest (the conductor's
 * routes for a cloud id).
 */
async function runUnpairRoute(assistantId: string): Promise<Response | null> {
  const entry = findAssistantByName(assistantId);
  if (!entry) {
    return null;
  }
  const result = unpairAssistant(assistantId);
  if (result.ok) {
    return json({ ok: true, lockfile: result.lockfile });
  }
  return json({ ok: false, error: result.error }, result.status);
}

/**
 * The device-code exchange that registers an assistant paired on another
 * machine: start an attempt from a pasted address, poll it until the host
 * approves, cancel it on the way out. It runs in the serving host rather
 * than the renderer, so the device code and the credentials it buy never
 * reach the renderer.
 */
async function runPairingStartRoute(
  _assistantId: string,
  request: Request,
): Promise<Response | null> {
  const body = await readJsonBody(request);
  if (!body) {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }
  const result = await pairingStart(body.address);
  if (!result.ok) {
    // `rejection` rides along so the renderer can show its own localized
    // copy for a refused address instead of this host's English.
    return json(
      {
        ok: false,
        reason: result.reason,
        error: result.error,
        rejection: result.rejection,
      },
      result.status,
    );
  }
  return json({
    ok: true,
    handle: result.handle,
    userCode: result.userCode,
    expiresAt: result.expiresAt,
    intervalSeconds: result.intervalSeconds,
  });
}

const RESOLUTION_PATTERN = /^\/v1\/assistant\/?$/;

/**
 * The caller's own credential headers, and nothing else. The resolution's
 * verdicts are the CALLER's — the gateway's `/healthz` auth check reads the
 * browser access cookie (or a bearer), so the operation forwards exactly
 * those headers upstream and never the host's own identity.
 */
function forwardedCredentials(headers: Headers): Record<string, string> {
  const forwarded: Record<string, string> = {};
  const cookie = headers.get("cookie");
  if (cookie) forwarded.cookie = cookie;
  const authorization = headers.get("authorization");
  if (authorization) forwarded.authorization = authorization;
  return forwarded;
}

function resolutionResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The platform's own detail for a cloud entry, normalized into the
 * resolution union. The cloud's status codes carry the arms the shell
 * renders — 401 no session, 409 still provisioning, 410 gone — and its 200
 * detail carries the identity; the operation translates so every surface
 * answers the SAME union shape.
 */
async function resolveCloudAssistant(
  entry: LockfileAssistant,
  headers: Headers,
): Promise<Response> {
  const detailUrl = `${getGatewayUrl(entry).replace(/\/+$/, "")}/v1/assistants/${encodeURIComponent(entry.assistantId ?? "")}/`;
  try {
    const response = await loopbackSafeFetch(detailUrl, {
      headers: { Accept: "application/json", ...forwardedCredentials(headers) },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 401) {
      return resolutionResponse({ status: "unauthenticated" });
    }
    if (response.status === 409) {
      return resolutionResponse({ status: "notReady" });
    }
    if (response.status === 410) {
      return resolutionResponse({ status: "unavailable" });
    }
    if (!response.ok) {
      return resolutionResponse({ status: "notReady" });
    }
    const detail = (await response.json().catch(() => null)) as {
      id?: unknown;
      version?: unknown;
      url?: unknown;
    } | null;
    if (
      typeof detail?.id !== "string" ||
      typeof detail.version !== "string" ||
      typeof detail.url !== "string"
    ) {
      return resolutionResponse({ status: "notReady" });
    }
    return resolutionResponse({
      status: "ready",
      assistant: { id: detail.id, version: detail.version, url: detail.url },
    });
  } catch {
    return resolutionResponse({ status: "notReady" });
  }
}

/**
 * The shell's resolution operation. One `GET /v1/assistant` answers the
 * whole resolution union so the app's hook is one fetch: the lockfile says
 * what is served (empty, a choice list, or the active-or-single entry), and
 * the entry's gateway says who it is and whether the CALLER's credentials
 * authenticate — `getGatewayHealth` rides the entry's gateway `/healthz`
 * (version + verdict in one round-trip; the caller's cookie forwarded, so
 * an authed gateway judges the browser, not the host). A cloud entry has no
 * host-side gateway: the platform's own detail carries the arms, and the
 * operation normalizes it into the same union.
 */
async function runAssistantResolution(headers: Headers): Promise<Response> {
  const lockfile = readLockfile();
  if (lockfile.assistants.length === 0) {
    return resolutionResponse({ status: "empty" });
  }
  const served =
    lockfile.assistants.find(
      (assistant) => assistant.assistantId === lockfile.activeAssistant,
    ) ??
    (lockfile.assistants.length === 1 ? lockfile.assistants[0] : undefined);
  if (!served?.assistantId) {
    // More than one entry and none active: the shell hands off to the
    // account chooser, which renders these rows.
    return resolutionResponse({
      status: "selection",
      assistants: lockfile.assistants.map((entry) => ({
        id: entry.assistantId,
        ...(entry.name ? { name: entry.name } : {}),
        remote: entry.cloud,
      })),
    });
  }
  if (isCloudEntry(served)) {
    return resolveCloudAssistant(served, headers);
  }
  const health = await getGatewayHealth(getGatewayUrl(served), {
    headers: forwardedCredentials(headers),
  });
  if (!health.authenticated) {
    return resolutionResponse({ status: "unauthenticated" });
  }
  if (!health.version) {
    // The gateway answered nothing (unreachable, still booting, or older
    // than the identity payload) — the assistant is not ready to mount.
    return resolutionResponse({ status: "notReady" });
  }
  return resolutionResponse({
    status: "ready",
    assistant: {
      id: served.assistantId,
      version: health.version,
      url: "assistant/",
    },
  });
}

async function runPairingPollRoute(
  _assistantId: string,
  request: Request,
): Promise<Response | null> {
  const body = await readJsonBody(request);
  if (!body) {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }
  const result = await pairingPoll({
    handle: body.handle,
    name: body.name,
  });
  if (!result.ok) {
    return json(
      { ok: false, reason: result.reason, error: result.error },
      result.status,
    );
  }
  if (result.status === "pending") {
    return json({
      ok: true,
      status: "pending",
      expiresAt: result.expiresAt,
      intervalSeconds: result.intervalSeconds,
    });
  }
  // Pairing never defines or saves a lockfile entry — imports create
  // entries; pairs pair with a defined one. The exchange's identity facts
  // go back to the page; creating the entry is the import's burden.
  return json({
    ok: true,
    status: "imported",
    assistantId: result.assistantId,
    accessOnly: result.accessOnly,
  });
}

async function runPairingCancelRoute(
  _assistantId: string,
  request: Request,
): Promise<Response | null> {
  const body = await readJsonBody(request);
  if (!body) {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }
  return json({ ok: pairingCancel(body.handle) });
}

/**
 * Paired-device management via the CLI (`cadet devices … --json`). POST-only
 * (the renderer always POSTs); run-helper results respond 200 with `ok`
 * discriminating success so all hosts share one wire shape.
 */
async function runDevicesRoute(
  isRevoke: boolean,
  request: Request,
): Promise<Response> {
  const body = await readJsonBody(request);
  if (!body) {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }
  const assistantId = body.assistantId;
  if (typeof assistantId !== "string" || !assistantId) {
    return json({ ok: false, error: "Missing assistantId" }, 400);
  }
  if (isRevoke) {
    const hashedDeviceId = body.hashedDeviceId;
    if (typeof hashedDeviceId !== "string" || !hashedDeviceId) {
      return json({ ok: false, error: "Missing hashedDeviceId" }, 400);
    }
    try {
      return json(await runDevicesRevoke(assistantId, hashedDeviceId));
    } catch (err) {
      return json({ ok: false, error: (err as Error).message });
    }
  }
  try {
    return json(await runDevicesList(assistantId));
  } catch (err) {
    return json({ ok: false, error: (err as Error).message });
  }
}

// The in-flight upgrade set: an upgrade POST flips the status route to
// `{ ok: true, state: "upgrading" }` until the CLI run settles, and a second
// upgrade for the same assistant refuses instead of stacking.
const upgradingLocalAssistantIds = new Set<string>();

/**
 * Upgrade the active local assistant's runtime through the CLI. The
 * in-flight set deduplicates concurrent upgrades for one assistant (the
 * status route reports the same state), and non-local entries are refused
 * by the operation itself. An id that is not an entry on this machine
 * passes — cloud ids ride the data-plane chain to the conductor's upgrade
 * route.
 */
async function runUpgradeRoute(
  assistantId: string,
  request: Request,
): Promise<Response | null> {
  const entry = findAssistantByName(assistantId);
  if (!entry) {
    return null;
  }
  const body = await readJsonBody(request);
  const options: UpgradeOptions =
    body === null
      ? {}
      : {
          ...(typeof body.latest === "boolean" ? { latest: body.latest } : {}),
          ...(typeof body.version === "string"
            ? { version: body.version }
            : {}),
          ...(typeof body.force === "boolean" ? { force: body.force } : {}),
        };
  if (!isActiveAssistant(assistantId)) {
    return json({
      ok: false,
      error: "Can only upgrade the active local assistant",
    });
  }
  if (upgradingLocalAssistantIds.has(assistantId)) {
    return json({
      ok: false,
      error: "An upgrade is already in progress for this assistant.",
    });
  }
  upgradingLocalAssistantIds.add(assistantId);
  try {
    const result = await runUpgrade(assistantId, options);
    if (!result.ok) {
      return json({ ok: false, error: result.error });
    }
    return json(
      result.version ? { ok: true, version: result.version } : { ok: true },
    );
  } finally {
    upgradingLocalAssistantIds.delete(assistantId);
  }
}

/**
 * The lifecycle probe for a local assistant's daemon and gateway (the
 * hatching screen polls it until the stack answers). The in-flight upgrade
 * state outranks the process probe — an upgrading assistant is not
 * "crashed", it is mid-restart. An id that is not an entry on this machine
 * passes — the data-plane chain forwards it.
 */
async function runStatusRoute(assistantId: string): Promise<Response | null> {
  const entry = findAssistantByName(assistantId);
  if (!entry) {
    return null;
  }
  if (upgradingLocalAssistantIds.has(assistantId)) {
    return json({ ok: true, state: "upgrading" });
  }
  return json(await getLocalAssistantStatus(assistantId));
}

/**
 * Read a local assistant's avatar straight off its workspace, so a sleeping
 * sibling still has an avatar in the chooser. An id that is not an entry on
 * this machine passes.
 */
async function runAvatarRoute(assistantId: string): Promise<Response | null> {
  const entry = findAssistantByName(assistantId);
  if (!entry) {
    return null;
  }
  return json(readLockfileAssistantAvatar(assistantId));
}

const ROUTES: OperatorRoute[] = [
  {
    method: "GET",
    pattern: RESOLUTION_PATTERN,
    run: (_assistantId, request) => runAssistantResolution(request.headers),
  },
  { method: "GET", pattern: LOCKFILE_PATTERN, run: () => runLockfileRoute() },
  { method: "POST", pattern: HATCH_PATTERN, run: runHatchRoute },
  {
    method: "POST",
    pattern: DEVICES_PATTERN,
    run: (_id, request) => runDevicesRoute(false, request),
  },
  {
    method: "POST",
    pattern: DEVICES_REVOKE_PATTERN,
    run: (_id, request) => runDevicesRoute(true, request),
  },
  {
    method: "POST",
    pattern: PAIRING_START_PATTERN,
    run: runPairingStartRoute,
  },
  { method: "POST", pattern: PAIRING_POLL_PATTERN, run: runPairingPollRoute },
  {
    method: "POST",
    pattern: PAIRING_CANCEL_PATTERN,
    run: runPairingCancelRoute,
  },
  { method: "DELETE", pattern: RETIRE_PATTERN, run: runRetireRoute },
  { method: "POST", pattern: SLEEP_PATTERN, run: runSleepRoute },
  { method: "POST", pattern: WAKE_PATTERN, run: runWakeRoute },
  { method: "POST", pattern: UNPAIR_PATTERN, run: runUnpairRoute },
  { method: "POST", pattern: UPGRADE_PATTERN, run: runUpgradeRoute },
  { method: "GET", pattern: STATUS_PATTERN, run: runStatusRoute },
  { method: "GET", pattern: AVATAR_PATTERN, run: runAvatarRoute },
];

/** A matched operator request: the route and its decoded target id. */
export interface OperatorMatch {
  route: OperatorRoute;
  /** The scoped rows' decoded target id; the unscoped rows' empty string. */
  assistantId: string;
}

/**
 * Match a request against the route table. Pure in `pathname` + `method`:
 * no lockfile read, no I/O — the hot path of every non-operator request
 * (static assets, gateway forwards, pairing) pays one regex walk. A scoped
 * row's pattern carries one capture group (the target id); an unscoped row's
 * carries none and decodes no id.
 */
export function matchOperatorRequest(
  pathname: string,
  method: string,
): OperatorMatch | null {
  for (const route of ROUTES) {
    if (method !== route.method) continue;
    const match = route.pattern.exec(pathname);
    if (!match) continue;
    try {
      return {
        route,
        // No-capture patterns (body-only routes) resolve to "" — the rows
        // that read an id never match on those patterns.
        assistantId: match[1] ? decodeURIComponent(match[1]) : "",
      };
    } catch {
      // Malformed percent-encoding: not this host's request.
      return null;
    }
  }
  return null;
}
