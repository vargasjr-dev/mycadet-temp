/**
 * The guardian credential cookies: the ONE transport for guardian tokens
 * between a holder and the gateway. Access and refresh tokens ride HttpOnly
 * cookies — never request bodies — so secrets cannot leak into body logs or
 * traces, and a browser webview needs no JavaScript-readable credential.
 *
 * Non-browser holders (the CLI, the daemon's token file) present the same
 * cookies by setting the Cookie header themselves and parse the rotated
 * tokens back out of the Set-Cookie response headers with
 * {@link parseSetCookieValues}.
 */

export const GUARDIAN_REFRESH_COOKIE = "cadet_web_refresh";

/** The access token rides its own HttpOnly cookie — JS holds no credential. */
export const GUARDIAN_ACCESS_COOKIE = "cadet_web_access";

/** Domain-scoped: the edge iframes the web UI at /web/assistant/ (its refresh runs at /web/v1/guardian/refresh, the shell's own at /v1/guardian/refresh) and the pairing challenge's publicBaseUrl carries none of that prefix, so a narrow path never matched. */
export const GUARDIAN_COOKIE_PATH = "/";

function guardianAuthCookie(
  name: string,
  value: string,
  maxAgeSeconds: number,
): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    `Path=${GUARDIAN_COOKIE_PATH}`,
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ].join("; ");
}

export function buildGuardianAuthCookies(params: {
  accessToken: string;
  accessTokenExpiresAtMs: number;
  refreshToken: string;
  refreshTokenExpiresAtMs: number;
}): string[] {
  const accessMaxAgeSeconds = Math.ceil(
    (params.accessTokenExpiresAtMs - Date.now()) / 1000,
  );
  const refreshMaxAgeSeconds = Math.ceil(
    (params.refreshTokenExpiresAtMs - Date.now()) / 1000,
  );
  return [
    guardianAuthCookie(
      GUARDIAN_ACCESS_COOKIE,
      params.accessToken,
      accessMaxAgeSeconds,
    ),
    guardianAuthCookie(
      GUARDIAN_REFRESH_COOKIE,
      params.refreshToken,
      refreshMaxAgeSeconds,
    ),
  ];
}

function getCookieFromHeader(header: string | null, name: string): string {
  if (!header) return "";

  for (const part of header.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName !== name) continue;
    const value = rawValue.join("=");
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  return "";
}

export function getGuardianAccessCookie(req: Request): string {
  return getCookieFromHeader(req.headers.get("cookie"), GUARDIAN_ACCESS_COOKIE);
}

export function getGuardianRefreshCookie(req: Request): string {
  return getCookieFromHeader(
    req.headers.get("cookie"),
    GUARDIAN_REFRESH_COOKIE,
  );
}

export function hasGuardianRefreshCookie(req: Request): boolean {
  return Boolean(getGuardianRefreshCookie(req));
}

/**
 * Pull a cookie's value out of a Set-Cookie response header. Non-browser
 * holders use this to read their rotated credentials — the new refresh token
 * travels only in Set-Cookie, never in a response body.
 */
export function parseSetCookieValues(
  setCookieHeaders: string[],
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const header of setCookieHeaders) {
    const [pair, ..._attributes] = header.split(";");
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const rawValue = pair.slice(eq + 1).trim();
    try {
      values[name] = decodeURIComponent(rawValue);
    } catch {
      values[name] = rawValue;
    }
  }
  return values;
}
