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

function publicBaseUrlMatchesRequestHost(
  req: Request,
  publicBaseUrl: string,
): boolean {
  const host = req.headers.get("host");
  if (!host) return false;
  const parsedHost = parseHostHeader(host);
  if (!parsedHost) return false;

  const publicUrl = new URL(publicBaseUrl);
  return publicUrl.hostname.toLowerCase() === parsedHost.toLowerCase();
}

/**
 * The public URL an edge-proxied mint is for: the request's own host, which
 * the edge fronts by construction.
 */
function selfSourceFromRequestHost(req: Request): string | null {
  const host = req.headers.get("host");
  if (!host) return null;
  const parsedHost = parseHostHeader(host);
  return parsedHost ? `https://${parsedHost}` : null;
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

  // The public URL the challenge is minted for. Callers with their own URL
  // state it (the device-side broker passes the address the user typed);
  // otherwise the gateway self-sources — the request's own host when it
  // arrived through the trusted edge (the edge fronts the public URL), else
  // the ingress URL recorded in this gateway's own workspace.
  const body = await readJsonObjectBody(req, MAX_CHALLENGE_BODY_BYTES);
  if (body instanceof Response) {
    return body;
  }
  const stated = body.publicBaseUrl;

  let publicBaseUrl: string | null;
  if (typeof stated === "string" && stated.trim()) {
    publicBaseUrl = parsePublicBaseUrl(stated);
    if (!publicBaseUrl) {
      return errorResponse("BAD_REQUEST", "publicBaseUrl is required", 400);
    }
    if (
      arrivedViaTrustedEdgeProxy &&
      !publicBaseUrlMatchesRequestHost(req, publicBaseUrl)
    ) {
      return errorResponse(
        "PUBLIC_BASE_URL_MISMATCH",
        "publicBaseUrl must match the request host",
        400,
      );
    }
  } else {
    publicBaseUrl = arrivedViaTrustedEdgeProxy
      ? selfSourceFromRequestHost(req)
      : readSavedIngressPublicBaseUrl();
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
