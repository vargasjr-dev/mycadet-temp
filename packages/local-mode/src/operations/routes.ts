import type { IncomingHttpHeaders } from "node:http";

import { isActiveAssistant, readLockfile } from "../lockfile";
import { pairingCancel, pairingPoll, pairingStart } from "../pair";
import { runDevicesList, runDevicesRevoke } from "../devices";
import { readLockfileAssistantAvatar } from "../avatar";
import { runHatch } from "../hatch";
import { runUpgrade, type UpgradeOptions } from "../upgrade";
import { unpairAssistant } from "../unpair";
import { servedConfigFromLockfile } from "../served-config";
import { runListRoute } from "./list";
import { findAssistantByName } from "./lookup";
import { retireAssistant } from "./retire";
import { runResolveRoute } from "./resolve";
import { sleepAssistant } from "./sleep";
import { wakeAssistant } from "./wake";
import { z } from "zod";

/**
 * The operator ROUTE TABLE: the host-served operations — the headless
 * lifecycle cores the serving host (Electron `app://` handler, Vite dev
 * middleware, the CLI edge's operation server) mounts before the gateway
 * data-plane planner. One entry per operation; today that is the assistant
 * resolution, retire, sleep, and wake. Future operations join as new rows
 * (and the gateway proxy itself becomes the LAST row — the catch-all
 * forward — once every scoped route is an operation).
 *
 * Patterns are declared ONCE per surface and DERIVED by two helpers: the
 * absolute rows declare a rooted pattern and `v1Friendly` derives its `/v1`
 * spelling; the assistant rows declare a tail pattern and `scopedAssistant`
 * adds scoping support (the id capture under the assistants namespace, plus
 * the unscoped spellings — the operator backend's active assistant) and then
 * applies `v1Friendly`. A matched request runs through
 * `match.route.run(match)` directly: the routes import the modules they
 * need, no injection surface.
 */
export interface OperatorRequest {
  /** The scoped rows' decoded target id; the unscoped rows resolve it. */
  assistantId: string;
  /**
   * The caller's own headers, forwarded so a credential-judging operation can
   * send the caller's own proof upstream — a verdict read host-side without
   * them would be the host's, not the caller's. Passed raw, whatever the
   * mount holds (a fetch Request's Headers, or the connect record).
   * Absent (direct `run` calls in tests) forwards nothing.
   */
  headers?: Headers | IncomingHttpHeaders;
  /**
   * The caller's body stream, carried for the body-carrying rows (hatch,
   * devices, pairing, upgrade) to read their JSON off. Absent (GET/HEAD,
   * direct `run` calls in tests) reads as no body.
   */
  body?: ReadableStream | null;
}

export interface OperatorRoute {
  method: string;
  /**
   * The DERIVED pattern — absolute rows' rooted pattern made v1-friendly,
   * assistant rows' tail pattern given scoping support. Matching is one
   * exec per row: no prefix walk, no surface bookkeeping.
   */
  pattern: RegExp;
  /**
   * Answer the request. Returning null means PASS: the request is not this
   * host's to answer (unknown id, or an entry the host cannot retire) and
   * the pre-existing chain answers instead — the cloud's 404 for a stale
   * id, the data-plane forward for a platform-hosted entry.
   */
  run: (request: OperatorRequest) => Promise<Response | null>;
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
async function runRetireRoute(
  request: OperatorRequest,
): Promise<Response | null> {
  const entry = findAssistantByName(request.assistantId);
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
  return new Response(JSON.stringify({ detail: result.error }), {
    status: result.status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The scoped surface's sleep arm. A `POST` on `/v1/assistants/{id}/sleep/`
 * for an entry this host can stop (local/docker) is answered host-side —
 * a bodyless 204 parses as the web bundle's success null; a failure (an
 * active call lease, a windows shutdown) carries the operation's message
 * and status. Entries the host cannot stop pass through, and the
 * pre-existing chain answers.
 */
async function runSleepRoute(
  request: OperatorRequest,
): Promise<Response | null> {
  const entry = findAssistantByName(request.assistantId);
  if (!entry) {
    return null;
  }
  const result = await sleepAssistant(entry);
  if (result.ok) {
    return new Response(null, { status: 204 });
  }
  return new Response(JSON.stringify({ detail: result.error }), {
    status: result.status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The scoped surface's wake arm. A `POST` on `/v1/assistants/{id}/wake/`
 * for an entry this host can start is answered host-side — the
 * non-destructive repair primitive the web bundle's connect-repair rides.
 * A docker entry whose containers were never created answers 404 pointing
 * at the CLI (the recreate needs the container-create builder, still
 * CLI-side); a bodyless 204 parses as the web bundle's success.
 */
async function runWakeRoute(
  request: OperatorRequest,
): Promise<Response | null> {
  const entry = findAssistantByName(request.assistantId);
  if (!entry) {
    return null;
  }
  const result = await wakeAssistant(entry);
  if (result.ok) {
    return new Response(null, { status: 204 });
  }
  return new Response(JSON.stringify({ detail: result.error }), {
    status: result.status,
    headers: { "content-type": "application/json" },
  });
}

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
/**
 * Helper 1 — the v1-friendly derivation: a rooted pattern also matches its
 * `/v1` spelling. The absolute rows apply it alone.
 */
function v1Friendly(rooted: RegExp): RegExp {
  return new RegExp(rooted.source.replace(/^\^/, "^(?:\\/v1)?"));
}

/**
 * Helper 2 — the scoping derivation: a tail pattern matches under BOTH
 * assistant reference spellings (the id capture of the assistants namespace,
 * and the bare assistant reference — the operator backend's active
 * assistant), then helper 1 adds the `/v1` spellings. The assistant rows
 * apply it alone.
 */
function scopedAssistant(tail: RegExp): RegExp {
  const tailSource = tail.source.replace(/^\^/, "").replace(/\$$/, "");
  const separator = tailSource === "" ? "\\/?" : "\\/";
  return v1Friendly(
    new RegExp(
      `^(?:\\/assistants\\/(?<id>[^\\/?#]+)|\\/assistant)${separator}(?:${tailSource})?\\/?$`,
    ),
  );
}

async function readJsonBody(
  body: ReadableStream | null | undefined,
): Promise<Record<string, unknown> | null> {
  const text = body ? await new Response(body).text().catch(() => "") : "";
  if (text.trim().length === 0) {
    return {};
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The hatch row's body: the requested remote override; junk degrades to a plain hatch. */
const HatchBodySchema = z
  .object({ remote: z.string().optional().catch(undefined) })
  .catch({});

/**
 * Provision a local assistant. Never rejects — failures resolve with
 * `{ ok: false, error }` so the renderer renders the same error UI the
 * status probe drives. The CLI owns the daemon + gateway process lifecycle:
 * a hatched local assistant runs its own daemon, and the serving host only
 * ever invokes the CLI as a subprocess.
 */
async function runHatchRoute(request: OperatorRequest): Promise<Response> {
  const { remote } = HatchBodySchema.parse(
    (await readJsonBody(request.body)) ?? {},
  );
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
async function runUnpairRoute(
  request: OperatorRequest,
): Promise<Response | null> {
  const entry = findAssistantByName(request.assistantId);
  if (!entry) {
    return null;
  }
  const result = unpairAssistant(request.assistantId);
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
  request: OperatorRequest,
): Promise<Response | null> {
  const body = await readJsonBody(request.body);
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

async function runPairingPollRoute(
  request: OperatorRequest,
): Promise<Response | null> {
  const body = await readJsonBody(request.body);
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
  request: OperatorRequest,
): Promise<Response | null> {
  const body = await readJsonBody(request.body);
  if (!body) {
    return json({ ok: false, error: "Invalid JSON body" }, 400);
  }
  return json({ ok: pairingCancel(body.handle) });
}

async function runDevicesListRoute(
  request: OperatorRequest,
): Promise<Response> {
  return runDevicesRoute(false, request);
}

async function runDevicesRevokeRoute(
  request: OperatorRequest,
): Promise<Response> {
  return runDevicesRoute(true, request);
}

/**
 * Paired-device management via the CLI (`cadet devices … --json`). POST-only
 * (the renderer always POSTs); run-helper results respond 200 with `ok`
 * discriminating success so all hosts share one wire shape.
 */
async function runDevicesRoute(
  isRevoke: boolean,
  request: OperatorRequest,
): Promise<Response> {
  const body = await readJsonBody(request.body);
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

// The in-flight upgrade set: a second upgrade POST for the same assistant
// refuses while the CLI run is still settling, instead of stacking.
const upgradingLocalAssistantIds = new Set<string>();

/**
 * Upgrade the active local assistant's runtime through the CLI. The
 * in-flight set deduplicates concurrent upgrades for one assistant, and
 * non-local entries are refused by the operation itself. An id that is not
 * an entry on this machine passes — cloud ids ride the data-plane chain to
 * the conductor's upgrade route.
 */
async function runUpgradeRoute(
  request: OperatorRequest,
): Promise<Response | null> {
  const assistantId = request.assistantId;
  const entry = findAssistantByName(assistantId);
  if (!entry) {
    return null;
  }
  const body = await readJsonBody(request.body);
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
 * Read a local assistant's avatar straight off its workspace, so a sleeping
 * sibling still has an avatar in the chooser. An id that is not an entry on
 * this machine passes.
 */
async function runAvatarRoute(
  request: OperatorRequest,
): Promise<Response | null> {
  const entry = findAssistantByName(request.assistantId);
  if (!entry) {
    return null;
  }
  return json(readLockfileAssistantAvatar(request.assistantId));
}

/** The operator route table, in match order. */
export const OPERATOR_ROUTES: readonly OperatorRoute[] = [
  // The shell's resolution: the assistant reference's bare tail answers the
  // whole union (scoped to an explicit id, or the active one unscoped).
  {
    method: "GET",
    pattern: scopedAssistant(/^$/),
    run: runResolveRoute,
  },
  // The list assistants contract: the chooser's and the store's roster read.
  {
    method: "GET",
    pattern: v1Friendly(/^\/assistants\/$/),
    run: runListRoute,
  },
  {
    method: "POST",
    pattern: v1Friendly(/^\/assistants\/hatch\/?$/),
    run: runHatchRoute,
  },
  {
    method: "POST",
    pattern: v1Friendly(/^\/devices\/?$/),
    run: runDevicesListRoute,
  },
  {
    method: "POST",
    pattern: v1Friendly(/^\/devices\/revoke\/?$/),
    run: runDevicesRevokeRoute,
  },
  {
    method: "POST",
    pattern: v1Friendly(/^\/remote-web\/pairing-start\/?$/),
    run: runPairingStartRoute,
  },
  {
    method: "POST",
    pattern: v1Friendly(/^\/remote-web\/pairing-poll\/?$/),
    run: runPairingPollRoute,
  },
  {
    method: "POST",
    pattern: v1Friendly(/^\/remote-web\/pairing-cancel\/?$/),
    run: runPairingCancelRoute,
  },
  {
    method: "DELETE",
    pattern: scopedAssistant(/^retire$/),
    run: runRetireRoute,
  },
  {
    method: "POST",
    pattern: scopedAssistant(/^sleep$/),
    run: runSleepRoute,
  },
  {
    method: "POST",
    pattern: scopedAssistant(/^wake$/),
    run: runWakeRoute,
  },
  {
    method: "POST",
    pattern: scopedAssistant(/^unpair$/),
    run: runUnpairRoute,
  },
  {
    method: "POST",
    pattern: scopedAssistant(/^upgrade$/),
    run: runUpgradeRoute,
  },
  {
    method: "GET",
    pattern: scopedAssistant(/^avatar\/get$/),
    run: runAvatarRoute,
  },
];

/** A matched operator request: the route and its decoded target id. */
export interface OperatorMatch {
  route: OperatorRoute;
  assistantId: string;
}

/**
 * Match a request against the route table: the first row whose DERIVED
 * pattern and method agree — one exec per row, no prefix walk, no surface
 * bookkeeping. Matching stays pure in the URL — the hot path of every
 * non-operator request (static assets, gateway forwards, pairing) pays a
 * regex pass and no I/O. Only a matched request reads the lockfile (to
 * resolve an unscoped match's active assistant id).
 */
export function matchOperatorRequest(
  pathname: string,
  method: string,
): OperatorMatch | null {
  for (const route of OPERATOR_ROUTES) {
    if (method !== route.method) {
      continue;
    }
    const match = route.pattern.exec(pathname);
    if (!match) {
      continue;
    }
    const id = match.groups?.id;
    if (!id) {
      // An unscoped match names the operator backend's active assistant —
      // the lockfile's active or sole entry, empty when there is none.
      return {
        route,
        assistantId: servedConfigFromLockfile(readLockfile()).assistantId ?? "",
      };
    }
    try {
      return { route, assistantId: decodeURIComponent(id) };
    } catch {
      // Malformed percent-encoding: not this host's request.
      return null;
    }
  }
  return null;
}

/**
 * The shared operator dispatcher: match a request against the route table
 * and run the matched route, threading the caller's own headers through.
 * Returning null means PASS — the request is not an operator request (or no
 * route owns it) and the serving host's pre-existing chain answers instead.
 * The serving hosts (the Electron `app://` handler, the Vite dev
 * middleware, the CLI edge's operation server) all dispatch through this
 * one function so their mounts cannot drift.
 */
export async function forwardOperatorRequest(
  request: Request,
): Promise<Response | null> {
  const match = matchOperatorRequest(
    new URL(request.url).pathname,
    request.method,
  );
  if (!match) {
    return null;
  }
  return match.route.run({
    assistantId: match.assistantId,
    headers: request.headers,
    body: request.body,
  });
}
