import { getGatewayHealth } from "../daemon-readiness";
import { readLockfile } from "../lockfile";
import { loopbackSafeFetch } from "../loopback-fetch";
import { getGatewayUrl, isCloudEntry } from "../lockfile-contract";
import type { LockfileAssistant } from "../lockfile-contract";
import { findAssistantByName } from "./lookup";
import { retireAssistant } from "./retire";
import { sleepAssistant } from "./sleep";
import { wakeAssistant } from "./wake";

/**
 * The operator ROUTE TABLE: the host-served operations — the headless
 * lifecycle cores the serving host (Electron `app://` handler, Vite dev
 * middleware) mounts before the gateway data-plane planner. One entry per
 * operation; today that is the assistant resolution, retire, sleep, and
 * wake. Future operations join as new rows (and the gateway proxy itself
 * becomes the LAST row — the catch-all forward — once every scoped route is
 * an operation).
 *
 * `matchOperatorRequest` is PURE in the URL — the hot path of every other
 * request never touches the lockfile. A match runs through
 * `match.route.run(match.assistantId, headers)` directly: the routes import
 * the modules they need, no injection surface.
 */

export interface OperatorRoute {
  method: string;
  pattern: RegExp;
  /**
   * Answer the request. Scoped rows receive the decoded target id; the
   * unscoped rows (no capture group) receive an empty string. The caller's
   * headers ride along so a credential-judging operation can forward the
   * caller's own proof upstream — a verdict read host-side without them
   * would be the host's, not the caller's.
   *
   * Returning null means PASS: the request is not this host's to answer
   * (unknown id, or an entry the host cannot retire) and the pre-existing
   * chain answers instead — the cloud's 404 for a stale id, the data-plane
   * forward for a platform-hosted entry.
   */
  run: (assistantId: string, headers: Headers) => Promise<Response | null>;
}

const RETIRE_PATTERN = /^\/v1\/assistants\/([^/?#]+)\/retire\/?$/;
const SLEEP_PATTERN = /^\/v1\/assistants\/([^/?#]+)\/sleep\/?$/;
const WAKE_PATTERN = /^\/v1\/assistants\/([^/?#]+)\/wake\/?$/;

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
async function runSleepRoute(assistantId: string): Promise<Response | null> {
  const entry = findAssistantByName(assistantId);
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
async function runWakeRoute(assistantId: string): Promise<Response | null> {
  const entry = findAssistantByName(assistantId);
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

const ROUTES: OperatorRoute[] = [
  {
    method: "GET",
    pattern: RESOLUTION_PATTERN,
    run: (_assistantId, headers) => runAssistantResolution(headers),
  },
  { method: "DELETE", pattern: RETIRE_PATTERN, run: runRetireRoute },
  { method: "POST", pattern: SLEEP_PATTERN, run: runSleepRoute },
  { method: "POST", pattern: WAKE_PATTERN, run: runWakeRoute },
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
        assistantId: match[1] !== undefined ? decodeURIComponent(match[1]) : "",
      };
    } catch {
      // Malformed percent-encoding: not this host's request.
      return null;
    }
  }
  return null;
}
