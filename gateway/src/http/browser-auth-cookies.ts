export const BROWSER_REFRESH_COOKIE = "cadet_web_refresh";

/** The access token rides its own HttpOnly cookie — JS holds no credential. */
export const BROWSER_ACCESS_COOKIE = "cadet_web_access";

/** Domain-scoped: the edge iframes the web UI at /web/assistant/ (its refresh runs at /web/v1/guardian/refresh, the shell's own at /v1/guardian/refresh) and the pairing challenge's publicBaseUrl carries none of that prefix, so a narrow path never matched. */
export const BROWSER_REFRESH_COOKIE_PATH = "/";

function browserAuthCookie(
  name: string,
  value: string,
  maxAgeSeconds: number,
): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    `Path=${BROWSER_REFRESH_COOKIE_PATH}`,
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ].join("; ");
}

export function buildRemoteWebBrowserAuthCookies(params: {
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
    browserAuthCookie(
      BROWSER_ACCESS_COOKIE,
      params.accessToken,
      accessMaxAgeSeconds,
    ),
    browserAuthCookie(
      BROWSER_REFRESH_COOKIE,
      params.refreshToken,
      refreshMaxAgeSeconds,
    ),
  ];
}

function getBrowserCookie(req: Request, name: string): string {
  const header = req.headers.get("cookie");
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

export function getRemoteWebAccessCookie(req: Request): string {
  return getBrowserCookie(req, BROWSER_ACCESS_COOKIE);
}

export function getRemoteWebRefreshCookie(req: Request): string {
  return getBrowserCookie(req, BROWSER_REFRESH_COOKIE);
}

export function hasRemoteWebRefreshCookie(req: Request): boolean {
  return Boolean(getRemoteWebRefreshCookie(req));
}
