/**
 * Pinning a WebSocket upgrade to this assistant's bound guardian.
 *
 * Some surfaces are the owner's own and nobody else's. Live voice runs in the
 * owner's client and the daemon stamps each turn with the guardian's trust
 * context; a watch session reads the owner's screen and the daemon resolves
 * whose screen from the guardian binding rather than from the request. Both
 * proxies replace the caller's identity with `mintServiceToken()` on the way
 * upstream, so the daemon cannot tell one actor from another: whatever the
 * gateway admits is what the daemon treats as the owner. The pin is therefore
 * the only place a non-guardian actor can be stopped.
 *
 * A valid actor edge JWT is not enough on its own. It proves the caller is an
 * actor on this assistant, not that they are the actor the surface belongs to.
 *
 * Two callers, two shapes, because there are two ways a caller arrives:
 *
 * - **Through tunnel.** Tunnel validates the browser's token, strips any
 *   client-supplied copies of the `X-Tunnel-*` headers, and injects the
 *   authenticated caller. That attestation proves the caller is *a* platform
 *   user who traversed tunnel, so it is cross-checked against the bound
 *   platform user id by {@link requireManagedGuardian}. A gateway takes
 *   this path when {@link acceptsTunnelAttestation} says it has a tunnel
 *   at all: a managed pod, or a locally hosted assistant whose gateway dialed
 *   tunnel so the mobile app can reach it.
 * - **Everything else.** The caller presents an actor edge JWT and its
 *   principal is compared against the binding by {@link requireBoundGuardian}.
 *
 * Not every audio proxy wants this. `/v1/stt/stream` carries dictation, which
 * is not a guardian-only surface and accepts any valid actor, which is why the
 * pin is something a route opts into rather than something the shared
 * authorization applies to everything. A runtime-stream proxy opts in by
 * calling {@link authorizeGuardianStream}, which runs both shapes in order.
 */

import type { Logger } from "pino";

import { authorizeRuntimeAudioStream } from "./runtime-audio-stream.js";
import { findCadetGuardian } from "../../auth/guardian-bootstrap.js";
import type { GatewayConfig } from "../../config.js";
import { requestHasTunnelBridgeAuth } from "../../tunnel/bridge-auth.js";
import { readStoredPlatformUserId } from "../../platform-user-id.js";

const TUNNEL_USER_ID_HEADER = "x-tunnel-user-id";
const TUNNEL_ORG_ID_HEADER = "x-tunnel-org-id";
const TUNNEL_ACTOR_HEADER = "x-tunnel-actor";

/**
 * True when the gateway runs in managed/cloud mode (vembda + tunnel ingress).
 * Mirrors the `IS_PLATFORM` check used by the gateway's HTTP edge auth
 * (`src/http/middleware/auth.ts`) and feature-flag resolver.
 */
export function isPlatformManaged(): boolean {
  const v = process.env.IS_PLATFORM?.trim().toLowerCase();
  return v === "1" || v === "true";
}

/**
 * True when a tunnel-attested caller can reach this gateway at all: a managed
 * pod, or any gateway started with a tunnel (`TUNNEL_BASE_URL`), which is
 * how a locally hosted assistant is reachable from the mobile app.
 *
 * Only the bridge proof makes an attestation trustworthy; this predicate says
 * whether there is a bridge to have come through. A gateway with no tunnel
 * never sees tunnel traffic, so its routes go straight to the token path.
 */
export function acceptsTunnelAttestation(
  config: Pick<GatewayConfig, "tunnelBaseUrl">,
): boolean {
  return isPlatformManaged() || config.tunnelBaseUrl !== undefined;
}

/** Tunnel-attested managed caller context, extracted from injected headers. */
export type TunnelAttestedContext = {
  userId: string;
  orgId: string;
};

/**
 * Extract a tunnel-attested managed caller context from the upgrade request.
 *
 * Returns null when the request does not carry a complete, well-formed tunnel
 * attestation (`X-Tunnel-User-Id` + `X-Tunnel-Org-Id` both present, with
 * `X-Tunnel-Actor: user`). Callers MUST only trust the result in managed mode,
 * and only alongside the process-local bridge proof: a direct request to a
 * reachable gateway can spoof the header names but not the proof value.
 */
export function extractTunnelAttestedContext(
  req: Request,
): TunnelAttestedContext | null {
  const userId = req.headers.get(TUNNEL_USER_ID_HEADER)?.trim();
  const orgId = req.headers.get(TUNNEL_ORG_ID_HEADER)?.trim();
  const actor = req.headers.get(TUNNEL_ACTOR_HEADER)?.trim().toLowerCase();

  if (!userId || !orgId || actor !== "user") {
    return null;
  }
  return { userId, orgId };
}

/**
 * Managed-mode guardian check: cross-check a tunnel-attested caller's platform
 * user id against the bound platform user id, the same guard the
 * edge-auth middleware applies to guardian routes under the platform bypass.
 *
 * Returns null when the caller is the guardian, else a 403/503 Response.
 */
export async function requireManagedGuardian(
  tunnelUserId: string,
  log: Logger,
): Promise<Response | null> {
  let storedUserId: string | undefined;
  let unreachable = false;
  try {
    const result = await readStoredPlatformUserId();
    storedUserId = result.userId;
    unreachable = result.unreachable;
  } catch (err) {
    log.error({ err }, "guardian pin: platform user id lookup failed");
    return new Response("Service Unavailable", { status: 503 });
  }
  if (unreachable) {
    log.warn("guardian pin: platform identity prerequisites unreachable");
    return new Response("Service Unavailable", { status: 503 });
  }
  if (!storedUserId) {
    log.warn("guardian pin: no platform user id bound on this assistant");
    return new Response("Forbidden", { status: 403 });
  }
  if (storedUserId !== tunnelUserId) {
    log.warn("guardian pin: tunnel caller is not the bound guardian");
    return new Response("Forbidden", { status: 403 });
  }
  return null;
}

/**
 * Actor-JWT guardian check: compare an already-validated actor principal
 * against this assistant's guardian binding.
 *
 * Returns null when the caller is the guardian, else a 403/503 Response. A
 * lookup that throws is 503 rather than 403: the answer is unknown, and
 * failing closed with "forbidden" would misreport a database problem as a
 * permission one.
 */
export async function requireBoundGuardian(
  actorPrincipalId: string,
  log: Logger,
): Promise<Response | null> {
  let guardian: { principalId: string } | null;
  try {
    guardian = await findCadetGuardian();
  } catch (err) {
    log.error({ err }, "guardian pin: findCadetGuardian failed");
    return new Response("Service Unavailable", { status: 503 });
  }
  if (!guardian || guardian.principalId !== actorPrincipalId) {
    log.warn("guardian pin: caller is not the bound guardian");
    return new Response("Forbidden", { status: 403 });
  }
  return null;
}

/**
 * The whole gate for a guardian-only runtime-stream upgrade: the tunnel-attested
 * managed path first, then the actor-token gate with the pin on top. Returns
 * null when the caller may open the socket, else the Response to send. An
 * incomplete attestation falls through, so managed still accepts an edge JWT.
 */
export async function authorizeGuardianStream(
  req: Request,
  config: GatewayConfig,
  log: Logger,
): Promise<Response | null> {
  // Checked here as well as in the shared gate, because the managed path
  // below skips that gate entirely: without this, a managed caller sending a
  // plain request would fall through to `server.upgrade` and get a 500.
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Upgrade Required", { status: 426 });
  }

  if (acceptsTunnelAttestation(config) && config.runtimeProxyRequireAuth) {
    const tunnelContext = extractTunnelAttestedContext(req);
    if (tunnelContext) {
      if (requestHasTunnelBridgeAuth(req)) {
        const guardianError = await requireManagedGuardian(
          tunnelContext.userId,
          log,
        );
        if (guardianError) {
          return guardianError;
        }
        log.info(
          { userId: tunnelContext.userId, orgId: tunnelContext.orgId },
          "guardian pin: authenticated via tunnel-attested managed context",
        );
        return null;
      }
      log.warn("guardian pin: ignoring tunnel context without bridge proof");
    }
  }

  const auth = authorizeRuntimeAudioStream(req, config, log);
  if (!auth.ok) {
    return auth.response;
  }
  // A null principal is the dev bypass: no token was validated, so there is
  // nothing to compare, and the bypass is not to be reintroduced here.
  if (auth.actorPrincipalId === null) {
    return null;
  }
  return requireBoundGuardian(auth.actorPrincipalId, log);
}
