import {
  rotateRefreshTokenByCookie,
  type RefreshErrorCode,
} from "../../auth/guardian-refresh.js";
import { getLogger } from "../../logger.js";
import {
  buildGuardianAuthCookies,
  getGuardianRefreshCookie,
} from "@mycadet/shared";
import type { RouteDefinition } from "./types.js";
import { getAuthRateLimiter } from "../../auth-rate-limiter.js";

const log = getLogger("guardian-refresh-route");
const REQUIRED_BROWSER_REFRESH_FETCH_SITE = "same-origin";
const BROWSER_REFRESH_FORBIDDEN_RESPONSE = {
  error: {
    code: "FORBIDDEN",
    message: "Browser refresh requires a same-origin request",
  },
};

function refreshFailureResponse(error: RefreshErrorCode): Response {
  // 403 for tokens that are valid-but-forbidden (revoked or reused); 401
  // for invalid/expired tokens and for guardian_repair_required (the status
  // clients treat as repairable).
  const forbidden: RefreshErrorCode[] = ["refresh_reuse_detected", "revoked"];
  const statusCode = forbidden.includes(error) ? 403 : 401;

  log.warn({ error }, "Refresh token rotation failed");
  return Response.json({ error }, { status: statusCode });
}

function browserRefreshResponse(
  result: Extract<
    ReturnType<typeof rotateRefreshTokenByCookie>,
    { ok: true }
  >["result"],
): Response {
  const headers = new Headers({ "Cache-Control": "no-store" });
  for (const cookie of buildGuardianAuthCookies({
    accessToken: result.accessToken,
    accessTokenExpiresAtMs: result.accessTokenExpiresAt,
    refreshToken: result.refreshToken,
    refreshTokenExpiresAtMs: result.refreshTokenExpiresAt,
  })) {
    headers.append("Set-Cookie", cookie);
  }

  return Response.json(
    {
      guardianPrincipalId: result.guardianPrincipalId,
      accessToken: result.accessToken,
      accessTokenExpiresAt: result.accessTokenExpiresAt,
      refreshTokenExpiresAt: result.refreshTokenExpiresAt,
      refreshAfter: result.refreshAfter,
    },
    { headers },
  );
}

function parseHttpUrl(value: string | null): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}

function sameEffectiveOrigin(req: Request, url: URL): boolean {
  const target = new URL(req.url);
  if (url.host !== target.host) return false;
  if (url.protocol === target.protocol) return true;
  return target.protocol === "http:" && url.protocol === "https:";
}

function browserRefreshFetchMetadataGuard(req: Request): Response | null {
  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite) {
    if (fetchSite === REQUIRED_BROWSER_REFRESH_FETCH_SITE) return null;
    return Response.json(BROWSER_REFRESH_FORBIDDEN_RESPONSE, { status: 403 });
  }

  // Older browsers skip the fetch-metadata headers but still announce where
  // the request came from; a same-effective-origin value passes and anything
  // else is cross-site.
  const origin = parseHttpUrl(req.headers.get("origin"));
  if (origin) {
    return sameEffectiveOrigin(req, origin)
      ? null
      : Response.json(BROWSER_REFRESH_FORBIDDEN_RESPONSE, { status: 403 });
  }
  const referer = parseHttpUrl(req.headers.get("referer"));
  if (referer) {
    return sameEffectiveOrigin(req, referer)
      ? null
      : Response.json(BROWSER_REFRESH_FORBIDDEN_RESPONSE, { status: 403 });
  }

  // No browser signals at all: a non-browser holder (the CLI, the daemon's
  // token file) presenting its own Cookie header. CSRF has nothing to ride
  // on — a web page cannot make another process's fetch — so it passes.
  return null;
}

export async function handleGuardianRefresh(req: Request): Promise<Response> {
  try {
    const refreshToken = getGuardianRefreshCookie(req);
    if (!refreshToken) {
      return Response.json(
        { error: { code: "UNAUTHORIZED", message: "Missing refresh cookie" } },
        { status: 401 },
      );
    }

    const metadataError = browserRefreshFetchMetadataGuard(req);
    if (metadataError) return metadataError;

    const result = rotateRefreshTokenByCookie({ refreshToken });
    if (!result.ok) {
      getAuthRateLimiter().recordFailure(new URL(req.url).hostname);
      return refreshFailureResponse(result.error);
    }

    log.info(
      {
        guardianPrincipalId: result.result.guardianPrincipalId,
      },
      "Refresh token rotation succeeded",
    );
    return browserRefreshResponse(result.result);
  } catch (err) {
    log.error({ err }, "Guardian refresh failed");
    return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

export const ROUTES: RouteDefinition[] = [
  {
    // The refresh endpoint's purpose is to obtain a new access token,
    // so rejecting expired tokens would create a deadlock once the JWT
    // expires. Cookie-only: every holder presents the refresh token as a
    // cookie, so the secret never appears in a request body.
    path: "/guardian/refresh",
    method: "post",
    auth: "custom",
    handler: (req) => handleGuardianRefresh(req),
  },
];
