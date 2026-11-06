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
  // the request's host when it arrived through the trusted edge (the edge
  // fronts the public URL), else the ingress URL recorded in this gateway's
  // own workspace. Callers cannot request a URL.
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

  // The edge stamps the client address it observed via proxy_set_header
  // (overwriting any inbound value), so it is trustworthy exactly when the
  // trusted-edge check above passed. Direct local mints keep the raw peer.
  const edgeClientIp = req.headers.get(EDGE_CLIENT_IP_HEADER)?.trim();

  const challenge = createRemoteWebPairingChallenge(publicBaseUrl, {
    ip: edgeClientIp || clientIp,
    userAgent: req.headers.get("user-agent"),
  });

  return Response.json(challenge, {
    headers: { "Cache-Control": "no-store" },
  });
}
