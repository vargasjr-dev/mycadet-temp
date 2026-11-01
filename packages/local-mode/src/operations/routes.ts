import type { LockfileAssistant } from "../lockfile-contract";
import { findAssistantByName } from "./lookup";
import { isHostExecutableRetireEntry, retireAssistant } from "./retire";
import { isHostExecutableSleepEntry, sleepAssistant } from "./sleep";

/**
 * The operator ROUTE TABLE: the host-served operations — the headless
 * lifecycle cores the serving host (Electron `app://` handler, Vite dev
 * middleware) mounts before the gateway data-plane planner. One entry per
 * operation; today that is retire and sleep. Future operations join as new
 * rows (and the gateway proxy itself becomes the LAST row — the catch-all
 * forward — once every scoped route is an operation).
 *
 * `matchOperatorRequest` is PURE in the URL — the hot path of every other
 * request never touches the lockfile. A match runs through
 * `match.route.run(match.assistantId)` directly: the routes import the
 * modules they need, no injection surface.
 */

export interface OperatorRoute {
  method: string;
  pattern: RegExp;
  /**
   * Answer the request. Returning null means PASS: the request is not this
   * host's to answer (unknown id, or an entry the host cannot retire) and
   * the pre-existing chain answers instead — the cloud's 404 for a stale id,
   * the data-plane forward for a platform-hosted entry.
   */
  run: (assistantId: string) => Promise<Response | null>;
}

const RETIRE_PATTERN = /^\/v1\/assistants\/([^/?#]+)\/retire\/?$/;
const SLEEP_PATTERN = /^\/v1\/assistants\/([^/?#]+)\/sleep\/?$/;

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
  if (!entry || !isHostExecutableRetireEntry(entry)) {
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
  if (!entry || !isHostExecutableSleepEntry(entry)) {
    return null;
  }
  const result = await sleepAssistant(entry, { force: false, wait: false });
  if (result.ok) {
    return new Response(null, { status: 204 });
  }
  return new Response(JSON.stringify({ detail: result.error }), {
    status: result.status,
    headers: { "content-type": "application/json" },
  });
}

const ROUTES: OperatorRoute[] = [
  { method: "DELETE", pattern: RETIRE_PATTERN, run: runRetireRoute },
  { method: "POST", pattern: SLEEP_PATTERN, run: runSleepRoute },
];

/** A matched operator request: the route and its decoded target id. */
export interface OperatorMatch {
  route: OperatorRoute;
  assistantId: string;
}

/**
 * Match a request against the route table. Pure in `pathname` + `method`:
 * no lockfile read, no I/O — the hot path of every non-operator request
 * (static assets, gateway forwards, pairing) pays one regex walk.
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
      return { route, assistantId: decodeURIComponent(match[1]!) };
    } catch {
      // Malformed percent-encoding: not this host's request.
      return null;
    }
  }
  return null;
}
