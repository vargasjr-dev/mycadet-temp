/**
 * WebSocket upstream URL helpers for gateway-to-assistant
 * WebSocket connections.
 *
 * Used by twilio relay/media, STT stream, watch and desktop stream routes
 * to construct upstream WebSocket URLs to the assistant runtime; the
 * dials assert the gateway's service identity in forwarded headers.
 */

// ---------------------------------------------------------------------------
// Protocol conversion
// ---------------------------------------------------------------------------

/**
 * Convert an HTTP(S) base URL to a WS(S) URL. Replaces the leading
 * `http` with `ws` (preserving `s` for TLS).
 */
export function httpToWs(httpBaseUrl: string): string {
  return httpBaseUrl.replace(/^http/, "ws");
}

// ---------------------------------------------------------------------------
// Upstream URL construction
// ---------------------------------------------------------------------------

export type WsUpstreamOptions = {
  /** HTTP base URL of the assistant runtime (e.g. `http://localhost:7821`). */
  baseUrl: string;
  /** Path on the upstream WS server (e.g. `/v1/stt/stream`). */
  path: string;
  /**
   * Additional query parameters to forward to the upstream.
   */
  extraParams?: Record<string, unknown>;
};

export type WsUpstreamResult = {
  /** Full upstream WebSocket URL with the extra params. */
  url: string;
  /** A version of the URL safe to log. */
  logSafeUrl: string;
};

/**
 * Build the upstream WebSocket URL for the assistant runtime.
 *
 * No token: the dialer authenticates with forwarded-identity headers on
 * the upgrade request (Bun's server-side WebSocket client can set
 * headers; the browser-facing edge it proxies for cannot).
 */
export function buildWsUpstreamUrl(opts: WsUpstreamOptions): WsUpstreamResult {
  const wsBase = httpToWs(opts.baseUrl.replace(/\/+$/, ""));
  const normalizedPath = opts.path.startsWith("/")
    ? opts.path
    : `/${opts.path}`;

  const query = new URLSearchParams();
  if (opts.extraParams) {
    for (const [key, value] of Object.entries(opts.extraParams)) {
      // Scalars ride the dial — numbers included: the runtime's watch route
      // reads numeric capture ids (and stt its sample rate) off this query.
      // Anything structured (the upstream socket, pending frames) does not.
      if (typeof value !== "string" && typeof value !== "number") continue;
      query.set(key, String(value));
    }
  }
  const qs = query.size > 0 ? `?${query.toString()}` : "";
  const url = `${wsBase}${normalizedPath}${qs}`;
  return { url, logSafeUrl: url };
}
