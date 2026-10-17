/**
 * Tunnel path allowlist sent to Tunnel on the WS upgrade request via the
 * {@link TUNNEL_ALLOWED_PATHS_HEADER} HTTP header. Tunnel parses the JSON-encoded
 * regex array on the cloud side
 * ({@link
 *   https://github.com/vargasjr-dev/mycadet-platform/blob/main/tunnel/internal/tunnel/protocol.go
 *   `RegistrationAllowedPathsHeader`})
 * and enforces it for every inbound HTTP and WebSocket proxy request routed
 * to this tunnel.
 *
 * Each entry is a Go RE2 regex string. Patterns are anchored at the start
 * (`^/...`) and either prefix-bound (trailing `/`) or exactly anchored (`$`)
 * depending on the route shape. Provider-side signature validation is
 * performed by the per-route handlers in the gateway runtime, not by Tunnel.
 *
 *   - `^/v1/watch/stream`: exact match for the browser watch-session
 *     WebSocket, which carries a session's narration audio.
 *   - `^/v1/desktop/stream`: exact match for the browser assistant-desktop
 *     WebSocket, a raw RFB byte pipe to the pod's VNC server. Guardian-only
 *     at the gateway handler, the same shape as the watch stream.
 *
 * If you add a new public route to `gateway/src/index.ts` that must be
 * reachable through the Tunnel (i.e. anything an external provider
 * calls or any unauthenticated callback endpoint), add a matching pattern
 * here as well. Webhook routes instead go in the webhook ingress registry,
 * which {@link buildTunnelAllowedPathsHeaderValue} advertises row by row. The
 * route-table guard test in `allowed-paths.test.ts` enforces symmetry between
 * the allowlist and the gateway's actual public surface.
 */

/**
 * Public routes outside the webhook namespace:
 *
 *   - `^/v1/audio/`: Twilio fetches generated audio URLs directly on the
 *     public surface (see comment at `gateway/src/index.ts` audio route).
 *   - `^/v1/live-voice$`: the browser live-voice WebSocket (the Twilio
 *     media-stream WebSocket rides the Twilio webhook prefix).
 *   - `^/v1/stt/stream$`: the public STT streaming WebSocket.
 *   - `^/assistant/credentials/enter$`: the gateway-served one-time
 *     credential entry page (self-contained HTML; the single-use token rides
 *     the URL fragment, which never reaches Tunnel or the gateway logs).
 *   - `^/v1/credential-requests/(peek|submit)$`: the entry page's
 *     unauthenticated API calls; the single-use token travels in the POST
 *     body and is validated by the gateway handlers.
 *   - `^/oauth/client-metadata.json$`: the public OAuth client document an
 *     authorization server fetches when it supports URL-based client ids.
 */
const TUNNEL_NON_WEBHOOK_ALLOWED_PATHS: readonly string[] = Object.freeze([
  "^/v1/audio/",
  "^/v1/live-voice$",
  "^/v1/stt/stream$",
  "^/v1/watch/stream$",
  "^/v1/desktop/stream$",
  "^/assistant/credentials/enter$",
  "^/v1/credential-requests/(peek|submit)$",
  "^/oauth/client-metadata\\.json$",
]);

/**
 * Twilio reaches the gateway on paths carrying call state in their segments
 * (`/webhooks/twilio/media-stream/<callSessionId>/<token>`), which an
 * exact-match registry row cannot express, so the whole Twilio subtree stays a
 * prefix rule.
 */
const TUNNEL_TWILIO_WEBHOOKS_PATH = "^/webhooks/twilio/";

/**
 * The rules that hold whatever the webhook ingress registry contains.
 * {@link buildTunnelAllowedPathsHeaderValue} appends one exact-match rule per
 * registered webhook path to these.
 */
export const TUNNEL_STATIC_ALLOWED_PATHS: readonly string[] = Object.freeze([
  TUNNEL_TWILIO_WEBHOOKS_PATH,
  ...TUNNEL_NON_WEBHOOK_ALLOWED_PATHS,
]);

/**
 * HTTP request header set on the WebSocket upgrade to declare the tunnel's
 * path allowlist to Tunnel. Mirrors `RegistrationAllowedPathsHeader` on the
 * platform side.
 */
export const TUNNEL_ALLOWED_PATHS_HEADER = "X-Cadet-Tunnel-Allowed-Paths";

const RE2_METACHARACTERS = /[.*+?^${}()|[\]\\]/g;

/** Escape `value` so it matches only itself under both RE2 and JavaScript. */
function escapeForRe2(value: string): string {
  return value.replace(RE2_METACHARACTERS, "\\$&");
}

/**
 * The header value to advertise for a tunnel serving the paths
 * `readRegisteredPaths` returns.
 *
 * The webhook namespace narrows to exactly the registered paths, so Tunnel
 * drops anything else under `/webhooks/` before it reaches the gateway.
 */
export function buildTunnelAllowedPathsHeaderValue(
  readRegisteredPaths: () => string[],
): string {
  return JSON.stringify([
    ...TUNNEL_STATIC_ALLOWED_PATHS,
    ...readRegisteredPaths().map((path) => `^${escapeForRe2(path)}$`),
  ]);
}
