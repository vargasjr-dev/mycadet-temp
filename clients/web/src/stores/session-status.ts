/**
 * Cloud-session liveness as a single tri-state.
 *
 * - `"unknown"`: the probe has not settled yet. The local gateway path
 *   authenticates before `getSession()` returns, so there is a window where
 *   logged-in status is known but session liveness is not. Imperative
 *   consumers (the onboarding fork) must wait this out before deciding;
 *   reactive consumers treat it as "no session" but a cached cloud
 *   assistant can stand in as a liveness hint.
 * - `"absent"`: the probe settled with no live cloud session.
 * - `"present"`: the probe settled with a live cloud session.
 *
 * Encoding it as one value makes "false that really means unknown"
 * unrepresentable, which is the ambiguity that let missing-session readers
 * silently treat the pre-settle window as a confirmed negative.
 */
export type CloudSessionStatus = "unknown" | "absent" | "present";

/**
 * Read predicates — the single place each session-state question is answered.
 *
 * Consumers read meaning (`hasLiveCloudSession`) instead of re-encoding the
 * enum literals (`=== "present"`) at every call site, so the encoding never
 * leaks into readers.
 */
export const hasLiveCloudSession = (status: CloudSessionStatus): boolean =>
  status === "present";

/**
 * The cloud-session probe has settled — `cloudSession` left the
 * `"unknown"` window and is now a definite `"present"` / `"absent"`. A
 * consumer whose behavior turns on cloud-session liveness must wait on this
 * before deciding.
 */
export const isCloudSessionSettled = (status: CloudSessionStatus): boolean =>
  status !== "unknown";

/**
 * Statuses where the server itself said "no session": allauth's 401 for
 * an unauthenticated probe, a 403, or 410 Gone (session invalidated).
 */
const SETTLED_SESSION_REJECTION_STATUSES = new Set([401, 403, 410]);

/**
 * A settled negative answer from a session check — the only failures
 * allowed to end the session. Everything else that isn't ok says nothing
 * about the session and must be treated as non-authoritative (LUM-2412):
 * a request that never completed (`status` undefined), rate limiting
 * (429), and gateway/outage 5xx including the Electron cloud proxy's
 * synthesized offline 502 (`proxy_network_error` — see
 * `clients/macos/src/main/cloud-forward.ts`). A session check that
 * throws outright (fetch rejection) is classified the same way by
 * callers.
 *
 * Structural parameter type (not `AllauthResult`) keeps this module
 * dependency-free per the header note.
 */
export const isSettledSessionRejection = (result: {
  ok: boolean;
  status?: number;
}): boolean =>
  !result.ok &&
  result.status !== undefined &&
  SETTLED_SESSION_REJECTION_STATUSES.has(result.status);
