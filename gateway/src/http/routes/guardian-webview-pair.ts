import {
  ensureCadetGuardianBinding,
  mintAndRecordBrowserTokenPair,
  CadetGuardianMintRefusedError,
} from "../../auth/guardian-bootstrap.js";
import { getLogger } from "../../logger.js";
import { buildGuardianAuthCookies } from "@mycadet/shared";
import type { RouteDefinition } from "./types.js";
import { getAuthRateLimiter } from "../../auth-rate-limiter.js";
import { validateEdgeToken } from "../../auth/token-exchange.js";
import { errorResponse } from "../loopback-guard.js";

const log = getLogger("guardian-webview-pair-route");

/**
 * Mint a browser-class credential pair for a webview the CALLER already
 * holds a guardian lease for — the daemon's hatch operation ships these
 * cookies to the hatched assistant's own webview so it starts with a jar
 * of its own (a per-holder token family: the webview rotates independently
 * of the daemon's lease, and neither holder's rotation can revoke the
 * other's).
 *
 * Auth mirrors the old refresh body door's trust ceiling: a signature-valid
 * bearer access token (the expiry check relaxed — a hatch can run right
 * after a wake, before the lease's first refresh). Minting is gated on the
 * guardian binding the same way the pairing exchange is.
 */
export async function handleGuardianWebviewPair(
  req: Request,
  getClientIp: (req: Request) => string,
): Promise<Response> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
    getAuthRateLimiter().recordFailure(getClientIp(req));
    log.warn(
      { path: new URL(req.url).pathname },
      "Guardian webview pair rejected: missing or malformed Authorization header",
    );
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const token = authHeader.slice(7);
  const verified = validateEdgeToken(token, { allowExpired: true });
  if (!verified.ok) {
    getAuthRateLimiter().recordFailure(getClientIp(req));
    log.warn(
      { path: new URL(req.url).pathname, reason: verified.reason },
      "Guardian webview pair rejected: token validation failed",
    );
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const guardianPrincipalId = await ensureCadetGuardianBinding();
    const pair = mintAndRecordBrowserTokenPair({
      guardianPrincipalId,
      platform: "web",
      identity: { pairingUserAgent: req.headers.get("user-agent") },
    });

    const headers = new Headers({ "Cache-Control": "no-store" });
    for (const cookie of buildGuardianAuthCookies({
      accessToken: pair.accessToken,
      accessTokenExpiresAtMs: pair.accessTokenExpiresAt,
      refreshToken: pair.refreshToken,
      refreshTokenExpiresAtMs: pair.refreshTokenExpiresAt,
    })) {
      headers.append("Set-Cookie", cookie);
    }

    log.info(
      { guardianPrincipalId },
      "Guardian webview pair minted for a hatched assistant",
    );
    return Response.json(
      {
        guardianPrincipalId,
        accessToken: pair.accessToken,
        accessTokenExpiresAt: pair.accessTokenExpiresAt,
        refreshTokenExpiresAt: pair.refreshTokenExpiresAt,
        refreshAfter: pair.refreshAfter,
      },
      { headers },
    );
  } catch (err) {
    if (err instanceof CadetGuardianMintRefusedError) {
      return errorResponse(
        "GUARDIAN_REPAIR_REQUIRED",
        "gateway guardian binding is missing over evidence of prior onboarding; repair via guardian init, then retry pairing",
        503,
      );
    }
    throw err;
  }
}

export const ROUTES: RouteDefinition[] = [
  {
    // The mint door for the daemon's hatch: the caller presents its own
    // guardian lease as the bearer access token, and the answer's cookies
    // are forwarded to the webview verbatim.
    path: "/guardian/webview-pair",
    method: "post",
    auth: "custom",
    handler: (req, _params, getClientIp) =>
      handleGuardianWebviewPair(req, getClientIp),
  },
];
