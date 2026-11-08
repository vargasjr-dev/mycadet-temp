import type { IncomingHttpHeaders } from "node:http";

import { isActiveAssistant, readLockfile } from "../lockfile";
import { pairingCancel, pairingPoll, pairingStart } from "../pair";
import { runDevicesList, runDevicesRevoke } from "../devices";
import { readLockfileAssistantAvatar } from "../avatar";
import { hatchAssistant } from "./hatch";
import { upgradeAssistant } from "./upgrade";
import { consoleLifecycleReporter } from "../lifecycle-reporter";
import { ownVersion } from "../environment";
import { unpairAssistant } from "../unpair";
import { servedConfigFromLockfile } from "../served-config";
import { runListRoute } from "./list";
import { findAssistantByName } from "./lookup";
import { retireAssistant } from "./retire";
import { runResolveRoute } from "./resolve";
import { sleepAssistant } from "./sleep";
import { wakeAssistant } from "./wake";
import { z } from "zod";
import { getGatewayUrl } from "../lockfile-contract";

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
   * The caller's method, carried for the proxy row (the other rows ignore
   * it — their table entry already names the method). Absent (direct `run`
   * calls in tests) reads as GET.
   */
  method?: string;
  /**
   * The caller's pathname + search, carried for the proxy row, which
   * forwards it verbatim to the entry's gateway. Absent (direct `run` calls
   * in tests) reads as the gateway root.
   */
  path?: string;
  /**
   * The raw peer address off the mount's server handle (Bun exposes it off
   * the handle, not the Request), carried for the proxy row's client-ip
   * fallback. Absent reads as a chain-less local caller (127.0.0.1).
   */
  peer?: string | null;
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
 * Helper 1 — the versioned derivation: a rooted pattern matches ONLY its
 * `/v1` and `/api` spellings — every api route nests under a version
 * prefix, since a bare spelling would collide with the frontend routes.
 * The absolute rows apply it alone.
 */
function v1Friendly(rooted: RegExp): RegExp {
  return new RegExp(rooted.source.replace(/^\^/, "^(?:\\/v1|\\/api)"));
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
  .object({
    remote: z
      .string()
      .nullish()
      .catch(undefined)
      .transform((remote) => remote ?? "local"),
  })
  .catch({ remote: "local" });

/** The upgrade row's body: the target version and force flag; junk reads as the defaults. */
const UpgradeBodySchema = z
  .object({
    version: z
      .string()
      .nullish()
      .catch(undefined)
      .transform((version) => version ?? null),
    force: z
      .boolean()
      .optional()
      .catch(undefined)
      .transform((force) => force ?? false),
  })
  .catch({ version: null, force: false });

/**
 * Provision a local assistant. Never rejects — failures resolve with
 * `{ ok: false, error }` so the renderer renders the same error UI the
 * status probe drives. The CLI owns the daemon + gateway process lifecycle:
 * a hatched local assistant runs its own daemon, and the serving host only
 * ever invokes the CLI as a subprocess.
 */
async function runHatchRoute(request: OperatorRequest): Promise<Response> {
  const { remote } = HatchBodySchema.parse(await readJsonBody(request.body));
  try {
    const result = await hatchAssistant({ remote });
    if (result.ok) {
      return json({ ok: true, assistantId: result.assistant.assistantId });
    }
    return json({ ok: false, error: result.error }, result.status);
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
  const { version, force } = UpgradeBodySchema.parse(
    await readJsonBody(request.body),
  );
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
    const result = await upgradeAssistant({
      entry,
      version,
      force,
      // The host runs the CLI it ships with — its release drives the target.
      cliVersion: ownVersion() ? `v${ownVersion()}` : undefined,
      reporter: consoleLifecycleReporter,
    });
    if (!result.ok) {
      return json({ ok: false, error: result.error }, result.status);
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

/**
 * The hop-by-hop headers (RFC 9110 §7.6.1): connection-scoped wiring that
 * dies at the first proxy hop and must not ride a forward.
 */
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * The caller's headers, normalized for the forward: whatever the mount held
 * (a fetch Request's Headers, or the connect record's IncomingHttpHeaders)
 * becomes a real Headers — undefined values dropped, list values
 * comma-joined — with the host and the hop-by-hop wiring stripped. The
 * gateway's client-ip stamp is re-derived here: the rightmost
 * X-Forwarded-For entry is the edge-observed client (tunnel providers append
 * one; tailscale serve sets it); a chain-less caller of the local operator
 * is 127.0.0.1.
 */
function normalizeForwardHeaders(
  input: Headers | IncomingHttpHeaders | undefined,
  peer: string | null,
): Headers {
  const headers = new Headers();
  if (input instanceof Headers) {
    input.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (lower === "host" || HOP_BY_HOP_HEADERS.has(lower)) return;
      headers.append(lower, value);
    });
  } else if (input) {
    for (const [key, value] of Object.entries(input)) {
      const lower = key.toLowerCase();
      if (lower === "host" || HOP_BY_HOP_HEADERS.has(lower)) continue;
      if (value === undefined) continue;
      headers.append(lower, Array.isArray(value) ? value.join(", ") : value);
    }
  }
  const forwarded = headers.get("x-forwarded-for");
  headers.set(
    "X-Cadet-Client-Ip",
    forwarded?.split(",").pop()?.trim() || peer || "127.0.0.1",
  );
  return headers;
}

/**
 * The catch-all proxy row: everything the route table doesn't answer rides
 * to the entry's Cadet Gateway, which supports its own surface. The forward
 * streams both ways — the request body rides as the raw stream (`duplex:
 * "half"` is the fetch spec's requirement whenever body is a stream), and
 * redirects pass through un-followed (`redirect: "manual"` — the caller,
 * not this host, owns its own 3xx). The response streams back with the
 * hop-by-hop and length headers stripped: fetch decodes the upstream's
 * content-encoding, so the lengths no longer describe the bytes.
 *
 * `ASSISTANT_PROXY_TRANSPORT=ipc` opts the proxy row into the gateway's
 * IPC cutover: the forwarded request carries `x-cadet-proxy-server: ipc`,
 * the header the gateway's runtime-proxy treats as "serve via the
 * assistant's IPC socket when the route table admits it". The header is
 * SET (not appended) so the operator's toggle overrides anything the
 * browser supplied; the default stays HTTP until the cutover lands.
 */
async function runProxyRoute(
  request: OperatorRequest,
): Promise<Response | null> {
  const entry = findAssistantByName(request.assistantId);
  if (!entry) {
    return null;
  }
  const method = request.method ?? "GET";
  const target = new URL(request.path ?? "/", getGatewayUrl(entry));
  const hasBody = method !== "GET" && method !== "HEAD";
  const headers = normalizeForwardHeaders(request.headers, request.peer ?? null);
  if (process.env.ASSISTANT_PROXY_TRANSPORT === "ipc") {
    headers.set("x-cadet-proxy-server", "ipc");
  }
  const upstream = await fetch(target, {
    method,
    headers,
    ...(hasBody ? { body: request.body, duplex: "half" as const } : {}),
    redirect: "manual",
  });
  const outHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    console.log("UPSTREAM HEADER", key, value);
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) return;
    if (lower === "content-length" || lower === "content-encoding") return;
    outHeaders.append(key, value);
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: outHeaders,
  });
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
  {
    method: "ALL",
    pattern: scopedAssistant(/^.+$/),
    run: runProxyRoute,
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
    if (method !== route.method && route.method !== "ALL") {
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
  const url = new URL(request.url);
  return match.route.run({
    assistantId: match.assistantId,
    method: request.method,
    path: url.pathname + url.search,
    headers: request.headers,
    body: request.body,
  });
}
