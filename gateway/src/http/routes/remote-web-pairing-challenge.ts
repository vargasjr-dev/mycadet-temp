import {
  checkRemoteWebPairingChallengeCapacity,
  createRemoteWebPairingChallenge,
  type RemoteWebPairingChallengeCapacityLimit,
} from "../../remote-web/pairing-challenge-store.js";
import {
  recordRemoteWebPairingChallengeCreation,
  type RemoteWebPairingChallengeRateLimit,
} from "../../remote-web/pairing-challenge-rate-limit-store.js";
import { isLoopbackAddress } from "../../util/is-loopback-address.js";
import {
  EDGE_CLIENT_IP_HEADER,
  requestArrivedViaEdgeProxy,
} from "../edge-forwarded-header.js";
import {
  enforceLoopbackOnly,
  errorResponse,
  parseHostHeader,
} from "../loopback-guard.js";
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
  rawPeerIp = clientIp,
): Promise<Response> {
  if (req.method !== "POST") {
    return methodNotAllowed("POST");
  }

  const arrivedViaEdgeProxy = requestArrivedViaEdgeProxy(req);
  const arrivedViaTrustedEdgeProxy =
    arrivedViaEdgeProxy && isLoopbackAddress(rawPeerIp);
  if (!arrivedViaTrustedEdgeProxy) {
    const guardError = enforceLoopbackOnly(
      req,
      clientIp,
      "remote-web-pairing-challenge",
    );
    if (guardError) return guardError;
  }

  // The public URL the challenge is minted for is always the gateway's own —
  // the request's host when it arrived through the trusted edge (the edge
  // fronts the public URL), else the ingress URL recorded in this gateway's
  // own workspace. Callers cannot request a URL.
  const body = await readJsonObjectBody(req, MAX_CHALLENGE_BODY_BYTES);
  if (body instanceof Response) {
    return body;
  }

  let publicBaseUrl: string | null;
  if (arrivedViaTrustedEdgeProxy) {
    const host = req.headers.get("host");
    const parsedHost = host ? parseHostHeader(host) : null;
    if (!parsedHost) {
      return errorResponse(
        "BAD_REQUEST",
        "no host header to self-source the public url from",
        400,
      );
    }
    publicBaseUrl = `https://${parsedHost}`;
  } else {
    publicBaseUrl = readSavedIngressPublicBaseUrl();
    if (publicBaseUrl) {
      const strict = parsePublicBaseUrl(publicBaseUrl);
      publicBaseUrl =
        strict !== null && isPublicHttpAddress(strict) ? strict : null;
    }
    if (!publicBaseUrl) {
      return errorResponse(
        "BAD_REQUEST",
        "no public URL is recorded for this gateway — run `cadet tunnel start` first",
        400,
      );
    }
  }

  const rateLimited = recordRemoteWebPairingChallengeCreation();
  if (rateLimited) return rateLimitedResponse(rateLimited);

  const capacityLimited = checkRemoteWebPairingChallengeCapacity();
  if (capacityLimited) return capacityLimitedResponse(capacityLimited);

  // The edge stamps the client address it observed via proxy_set_header
  // (overwriting any inbound value), so it is trustworthy exactly when the
  // trusted-edge check above passed. Direct local mints keep the raw peer.
  const edgeClientIp = arrivedViaTrustedEdgeProxy
    ? req.headers.get(EDGE_CLIENT_IP_HEADER)?.trim()
    : undefined;

  const challenge = createRemoteWebPairingChallenge(publicBaseUrl, {
    ip: edgeClientIp || clientIp,
    userAgent: req.headers.get("user-agent"),
    viaEdgeProxy: arrivedViaTrustedEdgeProxy,
  });

  return Response.json(challenge, {
    headers: { "Cache-Control": "no-store" },
  });
}
