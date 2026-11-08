/**
 * Host-approval routes for remote-web pairing requests: list the pending
 * challenges, then approve or deny one by its server-minted request id. This
 * is the surface behind the settings "Pair a device" approval UI (see the
 * header comment in
 * `clients/web/src/domains/settings/pair-device/pair-device-client.ts`).
 *
 * All three routes are loopback-gated and unauthenticated: running on the
 * host IS the authorization, exactly like the pairing-challenge/verification
 * routes. A remote paired session must never reach them, which the server-side
 * loopback guard enforces regardless of any client-side hiding.
 */

import type {
  RemoteWebPairingRequestDenyResponse,
  RemoteWebPairingRequestListResponse,
} from "@mycadet/service-contracts/remote-web-pairing";

import {
  approveRemoteWebPairingChallengeById,
  denyRemoteWebPairingChallengeById,
  listPendingRemoteWebPairingChallenges,
} from "../../remote-web/pairing-challenge-store.js";
import { errorResponse, isLoopbackHostHeader } from "../loopback-guard.js";
import { methodNotAllowed, readJsonStringField } from "../route-helpers.js";

const MAX_ACTION_BODY_BYTES = 256;

/** The three routes are host-machine-only; running on the host is the auth. */
function rejectRemoteCaller(req: Request): Response | null {
  if (!isLoopbackHostHeader(req.headers.get("host"))) {
    return errorResponse("FORBIDDEN", "endpoint is local-only", 403);
  }
  return null;
}

export function handleListRemoteWebPairingRequests(req: Request): Response {
  const remote = rejectRemoteCaller(req);
  if (remote) return remote;
  if (req.method !== "GET") {
    return methodNotAllowed("GET");
  }

  return Response.json(
    {
      requests: listPendingRemoteWebPairingChallenges(),
    } satisfies RemoteWebPairingRequestListResponse,
    { headers: { "Cache-Control": "no-store" } },
  );
}

// No code-guess rate limiter on approve/deny: request ids are server-minted
// opaque ids from the list route, not guessable secrets typed by users.
export async function handleApproveRemoteWebPairingRequest(
  req: Request,
): Promise<Response> {
  const remote = rejectRemoteCaller(req);
  if (remote) return remote;
  if (req.method !== "POST") {
    return methodNotAllowed("POST");
  }
  const requestId = await readJsonStringField(
    req,
    MAX_ACTION_BODY_BYTES,
    "requestId",
  );
  if (requestId instanceof Response) {
    return requestId;
  }

  const result = approveRemoteWebPairingChallengeById(requestId);
  if (result.status === "invalid") {
    return errorResponse("INVALID_REQUEST_ID", "unknown pairing request", 404);
  }
  if (result.status === "expired") {
    return errorResponse("EXPIRED_REQUEST", "pairing request expired", 410);
  }

  return Response.json(result, { headers: { "Cache-Control": "no-store" } });
}

export async function handleDenyRemoteWebPairingRequest(
  req: Request,
): Promise<Response> {
  const remote = rejectRemoteCaller(req);
  if (remote) return remote;
  if (req.method !== "POST") {
    return methodNotAllowed("POST");
  }
  const requestId = await readJsonStringField(
    req,
    MAX_ACTION_BODY_BYTES,
    "requestId",
  );
  if (requestId instanceof Response) {
    return requestId;
  }

  const result = denyRemoteWebPairingChallengeById(requestId);
  if (result.status === "invalid") {
    return errorResponse("INVALID_REQUEST_ID", "unknown pairing request", 404);
  }
  if (result.status === "already_approved") {
    return errorResponse(
      "ALREADY_APPROVED",
      "this pairing request was already approved on another surface",
      409,
    );
  }

  return Response.json(
    { status: "denied" } satisfies RemoteWebPairingRequestDenyResponse,
    { headers: { "Cache-Control": "no-store" } },
  );
}
