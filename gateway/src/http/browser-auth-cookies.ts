export const BROWSER_REFRESH_COOKIE = "cadet_web_refresh";

/**
 * The refresh cookie is domain-scoped (`Path=/`). The browser's refresh fetch
 * path depends on the prefix the bundle is served under — the app-shell edge
 * iframes the web UI at `/web/assistant/`, so its calls run at
 * `/web/v1/guardian/refresh` while the shell's own run at `/v1/guardian/refresh`
 * — and the pairing challenge's publicBaseUrl (minted CLI-side with the tunnel
 * URL) carries none of that. A narrowly scoped path never matched the requests
 * that needed the cookie, so the session could not survive a reload.
 */
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
  refreshToken: string;
  refreshTokenExpiresAtMs: number;
}): string[] {
  const maxAgeSeconds = Math.ceil(
    (params.refreshTokenExpiresAtMs - Date.now()) / 1000,
  );
  return [
    browserAuthCookie(
      BROWSER_REFRESH_COOKIE,
      params.refreshToken,
      maxAgeSeconds,
    ),
  ];
}

export function getRemoteWebRefreshCookie(req: Request): string {
  const header = req.headers.get("cookie");
  if (!header) return "";

  for (const part of header.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName !== BROWSER_REFRESH_COOKIE) continue;
    const value = rawValue.join("=");
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  return "";
}

export function hasRemoteWebRefreshCookie(req: Request): boolean {
  return Boolean(getRemoteWebRefreshCookie(req));
}
