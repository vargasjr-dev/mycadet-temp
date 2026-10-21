export const BROWSER_REFRESH_COOKIE = "cadet_web_refresh";

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
    // The remote-web flow is cross-site by construction: the paired browser
    // lives on another origin (the hub, or localhost during development) and
    // exchanges/refreshes over cross-origin fetches with
    // `credentials: "include"`. Browsers refuse to STORE a Strict/Lax cookie
    // from a cross-site response, so pairing silently failed to persist and
    // every refresh demanded a re-pair. None is the only mode a cross-site
    // response may store; Partitioned keys it per top-level site so it also
    // survives third-party-cookie phase-outs (CHIPS).
    "SameSite=None",
    "Partitioned",
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
