import {
  checkRemoteWebPairingChallengeCapacity,
  createRemoteWebPairingChallenge,
  type RemoteWebPairingChallengeCapacityLimit,
} from "../../remote-web/pairing-challenge-store.js";
import {
  recordRemoteWebPairingChallengeCreation,
  type RemoteWebPairingChallengeRateLimit,
} from "../../remote-web/pairing-challenge-rate-limit-store.js";
import { EDGE_CLIENT_IP_HEADER } from "../edge-forwarded-header.js";
import { errorResponse } from "../loopback-guard.js";
import { isLoopbackAddress } from "../../util/is-loopback-address.js";
import {
  parsePublicBaseUrl,
  readSavedIngressPublicBaseUrl,
} from "../../remote-web/public-base-url.js";
import { methodNotAllowed, readJsonObjectBody } from "../route-helpers.js";

const MAX_CHALLENGE_BODY_BYTES = 512;

function rateLimitedResponse(
  rateLimit: RemoteWebPairingChallengeRateLimit,
): Response {
  return Response.json(
    {
      error: {
        code: "RATE_LIMITED",
        message: "too many remote web pairing challenges",
      },
    },
    {
      status: 429,
      headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
    },
  );
}

function capacityLimitedResponse(
  capacityLimit: RemoteWebPairingChallengeCapacityLimit,
): Response {
  return Response.json(
    {
      error: {
        code: "PAIRING_CHALLENGE_CAPACITY_EXCEEDED",
        message: "too many pending remote web pairing challenges",
      },
    },
    {
      status: 429,
      headers: { "Retry-After": String(capacityLimit.retryAfterSeconds) },
    },
  );
}

/**
 * The marker the nginx edge stamps on proxied requests. The edge connects
 * over loopback, so a non-loopback peer carrying it is spoofing — but the
 * stamp's job here is only to vouch for the client-ip header, never to
 * admit a stranger.
 */
const EDGE_FORWARDED_HEADER = "x-cadet-edge-forwarded";

/**
 * A self-sourced URL must serve devices outside the host machine — a link
 * that encodes a loopback or plain-http address is unusable from another
 * device.
 */
function isPublicHttpAddress(url: string): boolean {
  try {
    return (
      new URL(url).protocol === "https:" &&
      !["localhost", "127.0.0.1", "::1"].includes(
        new URL(url).hostname.toLowerCase(),
      )
    );
  } catch {
    return false;
  }
}

export async function handleCreateRemoteWebPairingChallenge(
  req: Request,
  clientIp: string,
): Promise<Response> {
  if (req.method !== "POST") {
    return methodNotAllowed("POST");
  }

  // The public URL the challenge is minted for is always the gateway's own —
  // the ingress URL recorded in this gateway's own workspace, defaulting to
  // the gateway's local host when nothing is recorded. Callers cannot
  // request a URL.
  const body = await readJsonObjectBody(req, MAX_CHALLENGE_BODY_BYTES);
  if (body instanceof Response) {
    return body;
  }

  let publicBaseUrl = readSavedIngressPublicBaseUrl();
  if (publicBaseUrl) {
    const strict = parsePublicBaseUrl(publicBaseUrl);
    if (strict !== null && isPublicHttpAddress(strict)) {
      publicBaseUrl = strict;
    }
  }

  const rateLimited = recordRemoteWebPairingChallengeCreation();
  if (rateLimited) return rateLimitedResponse(rateLimited);

  const capacityLimited = checkRemoteWebPairingChallengeCapacity();
  if (capacityLimited) return capacityLimitedResponse(capacityLimited);

  // The gateway serves the local machine and its trusted edge. A stranger
  // arriving directly gets nothing — challenges are minted by the local
  // assistant or through the edge that fronts its public URL.
  const edgeForwarded =
    req.headers.get(EDGE_FORWARDED_HEADER)?.trim() === "1";
  const peerLoopback = isLoopbackAddress(clientIp);
  if (!peerLoopback && !edgeForwarded) {
    return errorResponse(
      "FORBIDDEN",
      "pairing challenges are minted by the local assistant or its trusted edge",
      403,
    );
  }

  // The edge stamps the client address it observed via proxy_set_header
  // (overwriting any inbound value), so the stamp is trustworthy exactly
  // when the marker is present. Direct local mints keep the raw peer — a
  // client-supplied x-cadet-client-ip is never believed there.
  const edgeClientIp = edgeForwarded
    ? req.headers.get(EDGE_CLIENT_IP_HEADER)?.trim()
    : undefined;

  const challenge = createRemoteWebPairingChallenge(publicBaseUrl, {
    ip: edgeClientIp || clientIp,
    userAgent: req.headers.get("user-agent"),
  });

  return Response.json(challenge, {
    headers: { "Cache-Control": "no-store" },
  });
}
