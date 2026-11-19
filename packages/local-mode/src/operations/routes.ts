import { isActiveAssistant, readLockfile } from "../lockfile";
import { pairingCancel, pairingPoll, pairingStart } from "../pair";
import { runDevicesList, runDevicesRevoke } from "../devices";
import { readLockfileAssistantAvatar } from "../avatar";
import { hatchAssistant } from "./hatch";
import { upgradeAssistant } from "./upgrade";
import { consoleLifecycleReporter } from "../lifecycle-reporter";
import { ownVersion } from "../environment";
import { unpairAssistant } from "../unpair";
import { servedAssistantFromLockfile } from "../served-config";
import { runListRoute } from "./list";
import { findAssistant } from "./lookup";
import { retireAssistant } from "./retire";
import { runUsernameAvailableRoute } from "./profile";
import {
  runDoctorHistoryListRoute,
  runDoctorHistoryRetrieveRoute,
  runDoctorSessionsCreateRoute,
  runDoctorSessionsDestroyRoute,
  runDoctorSessionsEventsRoute,
  runDoctorSessionsMessagesRoute,
  runDoctorSessionsUserOutcomeRoute,
} from "./doctor";
import { runMigrationsSignedUrlRoute } from "./migrations";
import { runResolveRoute } from "./resolve";
import { sleepAssistant } from "./sleep";
import { wakeAssistant } from "./wake";
import { z } from "zod";
import { getGatewayUrl, type LockfileAssistant } from "../lockfile-contract";
import { cookieHeader, parseSetCookie, type CookieJar } from "./cookie-jar";
import { CLOUD_ARM_PATTERN, forwardCloudRequest } from "./cloud-forward";
import type { HTTPMethod } from "@mycadet/shared/fetch";

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
 * absolute rows declare a relative pattern (no leading slash) and
 * `v1Friendly` derives its `/v1` spelling plus the optional trailing slash;
 * the assistant rows declare a tail pattern and `scopedAssistant` adds
 * scoping support (the id capture under the assistants namespace, plus
 * the unscoped spellings — the operator backend's active assistant) and
 * then applies `v1Friendly`. A matched request runs through
 * `match.route.run(match)` directly: the routes import the modules they
 * need, no injection surface.
 */
export interface OperatorRequest {
  /**
   * The assistant the request rides, resolved by the matcher: the scoped
   * rows' decoded target entry, the unscoped rows' served one (active, or
   * the sole entry before a selection), `null` when nothing resolves (the
   * empty roster behind the bare spelling — the choice rows' case).
   */
  assistant: LockfileAssistant | null;
  /**
   * The caller's method, carried for the proxy row (the other rows ignore
   * it — their table entry already names the method). The dispatcher
   * derives it off the mount's Request.
   */
  method: HTTPMethod;
  /**
   * The caller's pathname + search, carried for the proxy row, which
   * forwards it verbatim to the entry's gateway. The dispatcher derives
   * it off the mount's Request.
   */
  path: string;
  /**
   * The caller's headers, already normalized and cookied by the
   * dispatcher: host and hop-by-hop stripped, the client-ip stamp
   * derived, and the host jar's cookies for the entry's gateway origin
   * attached when the caller brought none. Every row receives the same
   * ready `Headers` — the credential-judging rows (the resolution's
   * health check, the proxy row's dial) send the caller's own proof
   * upstream, a verdict read host-side without them would be the host's,
   * not the caller's.
   */
  headers: Headers;
  /**
   * The caller's body stream, carried for the body-carrying rows (hatch,
   * devices, pairing, upgrade) to read their JSON off. Absent (GET/HEAD)
   * reads as no body.
   */
  body?: ReadableStream | null;
  /**
   * The caller's abort signal, carried for the streaming rows (the
   * doctor's event stream) so a client disconnect tears the upstream dial
   * down. Absent reads as no signal.
   */
  signal?: AbortSignal | null;
}

export interface OperatorRoute {
  method: HTTPMethod | "ALL";
  /**
   * The DERIVED pattern — absolute rows' rooted pattern made v1-friendly,
   * assistant rows' tail pattern given scoping support. Matching is one
   * exec per row: no prefix walk, no surface bookkeeping.
   */
  pattern: RegExp;
  /**
   * Answer the request. Returning null means PASS: the request is not this
   * host's to answer (an entry the host cannot retire, the proxy's
   * declined dial) and the dispatcher's chain answers instead — the
   * serving host's chain (assets, static).
   */
  run: (request: OperatorRequest) => Promise<Response | null>;
  /**
   * Whether the row's requests resolve to an assistant of this host's —
   * `false` only for the cloud arm, whose surfaces name no host entry and
   * whose answers' cookies are the cloud's session, never a gateway pair.
   */
  resolvesAssistant?: boolean;
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
  const entry = request.assistant;
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
  const entry = request.assistant;
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
  const entry = request.assistant;
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

const json = (
  body: unknown,
  status = 200,
  headers: Record<string, string | string[]> = {},
): Response => {
  // Array values append per element — the Headers record constructor
  // comma-joins them, which corrupts `Set-Cookie` (cookies carry commas
  // in their Expires attributes, and the pair would ride as one value).
  const out = new Headers({ "content-type": "application/json" });
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) out.append(name, item);
    } else {
      out.append(name, value);
    }
  }
  return new Response(JSON.stringify(body), { status, headers: out });
};

/**
 * Buffer and parse a JSON request body. An empty body resolves to `{}` (the
 * per-field validation reports what's missing); malformed JSON resolves to
 * `null`.
 */
/**
 * Helper 1 — the versioned derivation: a relative pattern (no leading
 * slash — every row declares its path relative) matches ONLY its `/v1` and
 * `/api` spellings — every api route nests under a version prefix, since a
 * bare spelling would collide with the frontend routes. The wrapper owns
 * every slash: it joins the version group to the relative body with the
 * leading `/` and appends the optional trailing one, so no row spells a
 * slash itself and both `/v1/assistants` and `/v1/assistants/` match.
 * The absolute rows apply it alone.
 */
function v1Friendly(relative: RegExp): RegExp {
  const body = relative.source.replace(/^\^/, "").replace(/\$$/, "");
  return new RegExp(`^(?:\\/v1|\\/api)\\/${body}\\/?$`);
}

/**
 * Helper 2 — the scoping derivation: a tail pattern matches under BOTH
 * assistant reference spellings (the id capture of the assistants namespace,
 * and the bare assistant reference — the operator backend's active
 * assistant), then helper 1 adds the `/v1` spellings and the slashes. The
 * assistant rows apply it alone.
 */
function scopedAssistant(tail: RegExp): RegExp {
  const tailSource = tail.source.replace(/^\^/, "").replace(/\$$/, "");
  const separator = tailSource === "" ? "" : "\\/";
  return v1Friendly(
    new RegExp(
      `(?:assistants\\/(?<id>[^\\/?#]+)|assistant)${separator}(?:${tailSource})?`,
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
      // The leg's own lease minted the webview's credential pair. It rides
      // the response as Set-Cookie headers — for natively-jarring browser
      // callers and QA visibility; the host jar's copy is the dispatcher's
      // job (it detects these headers one layer up and stores the pair for
      // the entry the leg just made active).
      return json(
        { ok: true, assistantId: result.assistant.assistantId },
        200,
        {
          "Set-Cookie": result.cookies,
        },
      );
    }
    return json({ ok: false, error: result.error }, result.status);
  } catch (err) {
    return json({ ok: false, error: (err as Error).message });
  }
}

/** The origin the entry's gateway serves on, or null when unresolvable. */
function gatewayOriginFor(entry: LockfileAssistant | null): string | null {
  if (!entry) {
    return null;
  }
  try {
    return new URL(getGatewayUrl(entry)).origin;
  } catch {
    return null;
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
  const entry = request.assistant;
  if (!entry) {
    return null;
  }
  const result = unpairAssistant(entry.assistantId);
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
  const entry = request.assistant;
  if (!entry) {
    return null;
  }
  const { version, force } = UpgradeBodySchema.parse(
    await readJsonBody(request.body),
  );
  if (!isActiveAssistant(entry.assistantId)) {
    return json({
      ok: false,
      error: "Can only upgrade the active local assistant",
    });
  }
  if (upgradingLocalAssistantIds.has(entry.assistantId)) {
    return json({
      ok: false,
      error: "An upgrade is already in progress for this assistant.",
    });
  }
  upgradingLocalAssistantIds.add(entry.assistantId);
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
    upgradingLocalAssistantIds.delete(entry.assistantId);
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
  const entry = request.assistant;
  if (!entry) {
    return null;
  }
  return json(readLockfileAssistantAvatar(entry.assistantId));
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
 * The dispatcher's header normalization: the mount's Request Headers
 * become the one `Headers` every row handles — the host and the
 * hop-by-hop wiring stripped. The gateway's client-ip stamp is re-derived
 * here: the rightmost X-Forwarded-For entry is the edge-observed client
 * (tunnel providers append one; tailscale serve sets it); a chain-less
 * caller of the local operator is 127.0.0.1.
 */
function normalizeForwardHeaders(
  input: Headers | undefined,
  peer: string | null,
): Headers {
  const headers = new Headers();
  input?.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower === "host" || HOP_BY_HOP_HEADERS.has(lower)) return;
    headers.append(lower, value);
  });
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
  const entry = request.assistant;
  if (!entry) {
    return null;
  }
  const method = request.method;
  const target = new URL(request.path, getGatewayUrl(entry));
  const hasBody = method !== "GET" && method !== "HEAD";
  // The dispatcher hands every row ready headers — normalized, with the
  // host jar's cookies for this gateway origin attached when the caller
  // brought none.
  const headers = request.headers;
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
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) return;
    if (lower === "content-length" || lower === "content-encoding") return;
    outHeaders.append(key, value);
  });
  // The upstream's Set-Cookie headers ride verbatim; the host jar's copy
  // of a rotation is the dispatcher's job one layer up.
  return new Response(upstream.body, {
    status: upstream.status,
    headers: outHeaders,
  });
}

/**
 * The operator route table, in match order.
 */
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
    pattern: v1Friendly(/^assistants$/),
    run: runListRoute,
  },
  {
    method: "GET",
    pattern: scopedAssistant(/^user\/username-available$/),
    run: runUsernameAvailableRoute,
  },
  // The doctor's whole session surface — host-side so the panel keeps
  // working when the entry's gateway is completely offline (the doctor's
  // main use case). Every row proxies verbatim to the cloud on the
  // operator's own credentials; the event stream is the one streaming row.
  {
    method: "GET",
    pattern: scopedAssistant(/^doctor\/history$/),
    run: runDoctorHistoryListRoute,
  },
  {
    method: "GET",
    pattern: scopedAssistant(/^doctor\/history\/[^\/?#]+$/),
    run: runDoctorHistoryRetrieveRoute,
  },
  {
    method: "POST",
    pattern: scopedAssistant(/^doctor\/sessions$/),
    run: runDoctorSessionsCreateRoute,
  },
  {
    method: "DELETE",
    pattern: scopedAssistant(/^doctor\/sessions\/[^\/?#]+$/),
    run: runDoctorSessionsDestroyRoute,
  },
  {
    method: "GET",
    pattern: scopedAssistant(/^doctor\/sessions\/[^\/?#]+\/events$/),
    run: runDoctorSessionsEventsRoute,
  },
  {
    method: "POST",
    pattern: scopedAssistant(/^doctor\/sessions\/[^\/?#]+\/messages$/),
    run: runDoctorSessionsMessagesRoute,
  },
  {
    method: "POST",
    pattern: scopedAssistant(/^doctor\/sessions\/[^\/?#]+\/user-outcome$/),
    run: runDoctorSessionsUserOutcomeRoute,
  },
  // The teleport signed-url row — host-served so the web bundle's backup
  // export hops to the cloud on the operator's own credentials instead of
  // needing a cloud session in the browser.
  {
    method: "POST",
    pattern: scopedAssistant(/^migrations\/signed-url$/),
    run: runMigrationsSignedUrlRoute,
  },
  {
    method: "POST",
    pattern: v1Friendly(/^assistants\/hatch$/),
    run: runHatchRoute,
  },
  {
    method: "POST",
    pattern: v1Friendly(/^devices$/),
    run: runDevicesListRoute,
  },
  {
    method: "POST",
    pattern: v1Friendly(/^devices\/revoke$/),
    run: runDevicesRevokeRoute,
  },
  {
    method: "POST",
    pattern: v1Friendly(/^remote-web\/pairing-start$/),
    run: runPairingStartRoute,
  },
  {
    method: "POST",
    pattern: v1Friendly(/^remote-web\/pairing-poll$/),
    run: runPairingPollRoute,
  },
  {
    method: "POST",
    pattern: v1Friendly(/^remote-web\/pairing-cancel$/),
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
  // Channel webhooks: the tunnel fronts the serving hosts only and the
  // gateway owns webhook ingress (gateway-only mode), so the subtree rides
  // this unscoped proxy row to the fronted assistant's gateway verbatim.
  // Each channel validates its own shared secret at the gateway — no bearer.
  {
    method: "ALL",
    pattern: /^\/webhooks(?:\/.*)?$/,
    run: runProxyRoute,
  },
  {
    method: "ALL",
    pattern: scopedAssistant(/^.+$/),
    run: runProxyRoute,
  },
  // The cloud's own surfaces as just another arm: the pattern is the
  // OR-union of the cloud's own prefixes, the run the cloud forward
  // itself. Last in match order — everything the operator rows don't
  // claim rides here, and the dispatcher's null (a row's pass, or no
  // match at all) hands the serving host's chain its turn. Its surfaces
  // name no assistant of this host's: no resolution, and its answers'
  // cookies are the cloud's session, never a gateway pair.
  {
    method: "ALL",
    pattern: CLOUD_ARM_PATTERN,
    run: forwardCloudRequest,
    resolvesAssistant: false,
  },
];

/** A matched operator request: the route and the assistant it rides. */
export interface OperatorMatch {
  route: OperatorRoute;
  /**
   * The assistant the request rides, resolved by the matcher: an
   * id-scoped URL names its own entry; the bare spelling rides the
   * operator backend's served assistant (active, or the sole entry
   * before a selection — a hatch's locked write has already switched
   * active to the minted entry by the time anything resolves post-run);
   * the cloud arm names none. `null` when nothing resolves.
   */
  assistant: LockfileAssistant | null;
  /** Whether the URL scoped its own entry's id (the bare spelling: no). */
  scoped: boolean;
}

/**
 * Match a request against the route table: the first row whose DERIVED
 * pattern and method agree — one exec per row, no prefix walk, no surface
 * bookkeeping — and resolve the assistant the request rides, so neither
 * the dispatcher nor the rows re-resolve it. Unmatched requests (the hot
 * path of every non-operator request: static assets, gateway forwards,
 * pairing) pay a regex pass and no I/O; a MATCHED request pays one
 * lockfile read here. An OPTIONS agrees with any row whose pattern
 * matches regardless of the row's method and answers 204 without
 * resolving or running the row (a preflight must not dial a gateway).
 */
function matchOperatorRequest(
  pathname: string,
  method: string,
): OperatorMatch | null {
  for (const route of OPERATOR_ROUTES) {
    if (
      method !== "OPTIONS" &&
      method !== route.method &&
      route.method !== "ALL"
    ) {
      continue;
    }
    const match = route.pattern.exec(pathname);
    if (!match) {
      continue;
    }
    // The cloud arm's surfaces name no assistant of this host's.
    if (route.resolvesAssistant === false || method === "OPTIONS") {
      return { route, assistant: null, scoped: false };
    }
    const id = match.groups?.id;
    if (!id) {
      // The bare spelling rides the operator backend's served assistant.
      return {
        route,
        assistant: servedAssistantFromLockfile(readLockfile()) ?? null,
        scoped: false,
      };
    }
    try {
      const assistantId = decodeURIComponent(id);
      return { route, assistant: findAssistant(assistantId), scoped: true };
    } catch {
      // Malformed percent-encoding: not this host's request.
      return null;
    }
  }
  return null;
}

/**
 * The shared operator dispatcher: match a request against the route table
 * and run the matched route. The dispatcher prepares EVERY row's inputs —
 * headers come out normalized (host and hop-by-hop stripped, the
 * client-ip stamp derived from `options.peer`) and cookied (the host
 * jar's cookies for the matched entry's gateway origin, when the caller
 * brought none and the host supplies a jar) — so operations only handle
 * `Headers`. The cloud's own surfaces are just the table's last row (an
 * OR-union of its prefixes); a CORS preflight is answered 204 before any
 * row runs, and whatever the rows don't claim (no match at all, a row's
 * pass — a stale id, an entry this host can't retire) comes back `null`
 * for the serving host's pre-existing chain. The serving hosts (the
 * Electron `app://` handler, the Vite dev middleware, the CLI edge's
 * operation server) all dispatch through this one function so their
 * mounts cannot drift.
 */
export async function forwardOperatorRequest(
  request: Request,
  options?: {
    peer?: string | null;
    cookieJar?: CookieJar;
  },
): Promise<Response | null> {
  const pathname = new URL(request.url).pathname;
  const match = matchOperatorRequest(pathname, request.method);
  if (!match) {
    return null;
  }
  // A CORS preflight names an operator surface but carries no intent of
  // its own — answer 204 and let the serving host wrap its CORS headers.
  // It must never reach a row: a preflight dialing a gateway is nonsense.
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }
  const { assistant, scoped } = match;
  // A URL that names an assistant must name an entry on this machine —
  // an unknown id is a 404, not a fall-through into whatever the host
  // chain answers for a path it has never heard of. The bare spelling
  // stays answerable with no entry: the empty roster, the first hatch.
  if (scoped && !assistant) {
    return json({ error: "no such assistant on this host" }, 404);
  }
  let jarOrigin: string | null = null;
  if (assistant) {
    try {
      jarOrigin = new URL(getGatewayUrl(assistant)).origin;
    } catch {
      if (scoped) {
        return json({ error: "no resolvable gateway for this assistant" }, 404);
      }
      // The shorthand's unresolvable origin: the jar attach skips.
    }
  }
  const headers = normalizeForwardHeaders(
    request.headers,
    options?.peer ?? null,
  );
  if (!headers.has("cookie") && options?.cookieJar && jarOrigin) {
    const jarCookies = await options.cookieJar.get(jarOrigin);
    if (jarCookies.length > 0) {
      headers.set("cookie", cookieHeader(jarCookies));
    }
  }
  const url = new URL(request.url);
  const response = await match.route.run({
    assistant,
    method: request.method as HTTPMethod,
    path: url.pathname + url.search,
    headers,
    body: request.body,
    signal: request.signal,
  });
  if (response) {
    // The jar's writes are the dispatcher's, one route-agnostic layer
    // above the rows: an answer that mints or rotates carries Set-Cookie
    // headers, and the pair belongs to the assistant it was minted for —
    // the match's own resolution when the request rode one; otherwise the
    // lockfile's fresh active pointer, which the first hatch's leg has
    // just switched inside its locked write. Only rows whose requests
    // resolve to an assistant of this host's pair cookies (the cloud
    // arm's answers are the cloud's session). Best-effort per the jar's
    // contract: the headers still ride the answer for natively-jarring
    // browser callers.
    const setCookies = response.headers.getSetCookie();
    if (
      options?.cookieJar &&
      setCookies.length > 0 &&
      match.route.resolvesAssistant !== false
    ) {
      const paired = assistant ?? findAssistant(null);
      const origin = paired ? gatewayOriginFor(paired) : null;
      if (origin) {
        for (const raw of setCookies) {
          const cookie = parseSetCookie(raw);
          if (cookie) await options.cookieJar.set(origin, cookie);
        }
      }
    }
    return response;
  }
  // A row's pass (an entry the host cannot retire, the proxy's declined
  // dial) is not this host's to answer — the serving host's chain takes
  // over.
  return null;
}
