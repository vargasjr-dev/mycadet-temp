/**
 * Request/response interceptors for the generated HeyAPI clients.
 *
 * For platform-bound requests, attaches:
 *   - `X-CSRFToken` (mutations only) — required by the cloud's
 *     SessionAuthentication.
 *   - `X-Cadet-Client-Id` + `X-Cadet-Interface-Id` — identify the
 *     originating tab/interface to the daemon. Required by self-echo
 *     suppression: the daemon echoes the client id back on the resulting
 *     `sync_changed` so the originator's SSE subscriber can be skipped.
 *
 * Import this module for its side effects in the app entrypoint
 * (`main.tsx`) so interceptors are installed before any API call fires.
 *
 * Reference: https://heyapi.dev/openapi-ts/clients/fetch#interceptors
 */
import { client as operatorClient } from "@/generated/operator/client.gen";
import { client as daemonClient } from "@/generated/daemon/client.gen";
import { client as gatewayClient } from "@/generated/gateway/client.gen";
import { getCsrfToken } from "@/lib/auth/csrf";
import { ApiError, toApiError } from "@/utils/api-errors";
import { currentLocale } from "@/i18n";
import { getClientRegistrationHeaders } from "@/lib/client-identity";
import { getDeviceId } from "@/runtime/device-id";
import { isElectron } from "@/runtime/is-electron";
import { getElectronSessionToken } from "@/runtime/session-token";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const ELECTRON_RENDERER_ORIGIN_HEADER = "X-Cadet-Electron-Renderer-Origin";

function getRendererTupleOrigin(): string {
  return `${window.location.protocol}//${window.location.host}`;
}

const PLATFORM_PUSH_FIRST_SEGMENTS = new Set<string>([
  "push-tokens",
  "live-activity",
]);

/**
 * Same resource match as the same path match, but allows an ingress
 * path prefix (`/assistant-123/v1/assistants/...`).
 */
const ASSISTANT_RESOURCE_RE = /\/v1\/assistants\/[^/]+\/(([^/?#]+)(?:\/.*)?)$/;

function isPlatformPushPath(url: string): boolean {
  const match = ASSISTANT_RESOURCE_RE.exec(new URL(url).pathname);
  return match !== null && PLATFORM_PUSH_FIRST_SEGMENTS.has(match[2]);
}

/**
 * Builds a request interceptor for a HeyAPI client.
 *
 * @param isDaemonClient `true` for the daemon + gateway clients. All
 *   assistant sub-resource paths are forwarded to the self-hosted gateway
 *   without consulting {@link RUNTIME_PROXIED_FIRST_SEGMENTS}. `false` for the
 *   cloud and auth clients, where only allowlisted segments are forwarded
 *   (platform-owned routes like system-events, etc. fall
 *   through to the cloud).
 */
function createInterceptor({
  isDaemonClient = false,
  allowRemoteGatewayDirect = false,
} = {}) {
  /**
   * `outgoing` is the request the chain hands downstream; `url` is the original
   * one, which still carries the cloud-shaped path a self-hosted rewrite
   * would have replaced.
   */

  const route = async (request: Request): Promise<Request> => {
    const newRequest = new Request(request);

    // Per-tab client identity — sent on *every* request (GET included)
    // so SSE-via-fetch readers and short-lived mutations carry the same
    // id. Stamped first so it rides on both the cloud and
    // self-hosted paths.
    for (const [name, value] of Object.entries(
      getClientRegistrationHeaders(),
    )) {
      newRequest.headers.set(name, value);
    }

    newRequest.headers.set("Accept-Language", currentLocale());

    if (allowRemoteGatewayDirect) {
      return newRequest;
    }

    if (!isDaemonClient && isPlatformPushPath(newRequest.url)) {
      return newRequest;
    }

    // Platform path — cloud session auth.
    if (isElectron() && MUTATING_METHODS.has(request.method)) {
      newRequest.headers.set(
        ELECTRON_RENDERER_ORIGIN_HEADER,
        getRendererTupleOrigin(),
      );
    }

    const deviceId = getDeviceId();
    if (deviceId) {
      newRequest.headers.set("Cadet-Device-Id", deviceId);
    }

    // Electron app provides a session token header. This is no-ops on web.
    const sessionToken = getElectronSessionToken();
    if (sessionToken) {
      newRequest.headers.set("X-Session-Token", sessionToken);
    }

    // Clients authenticating via session cookie need to pass CSRF checks.
    // Electron authenticates via a session token header.
    if (!isElectron() && MUTATING_METHODS.has(request.method)) {
      const csrfToken = getCsrfToken();
      if (csrfToken) {
        newRequest.headers.set("X-CSRFToken", csrfToken);
      }
    }

    return newRequest;
  };

  return async (request: Request): Promise<Request> => {
    return route(request);
  };
}

/** Platform + auth clients: uses the segment allowlist. */
export const requestInterceptor = createInterceptor({});

/** Daemon client: bypasses the segment allowlist. */
export const daemonRequestInterceptor = createInterceptor({
  isDaemonClient: true,
  allowRemoteGatewayDirect: true,
});

const gatewayRequestInterceptor = createInterceptor({
  isDaemonClient: true,
  allowRemoteGatewayDirect: true,
});

/**
 * Normalizes HeyAPI's raw thrown errors into {@link ApiError} instances
 * for `throwOnError: true` calls only.
 *
 * HeyAPI's fetch client throws the parsed JSON response body (a plain
 * object) on non-OK responses. Downstream consumers like
 * {@link shouldRetryDaemonError} match on `error instanceof ApiError`
 * to decide whether to retry transient HTTP errors (503, 502, 401).
 * Without this interceptor, those checks always fail and retries never
 * fire.
 *
 * Only applies when the caller set `throwOnError: true` (generated
 * query factories). Callers using `throwOnError: false` inspect the
 * raw error body for machine-readable fields (e.g. `error: "secret_blocked"`
 * from `postChatMessage`) — wrapping those into `ApiError` would discard
 * the structured payload.
 *
 * Reference: https://heyapi.dev/openapi-ts/clients/fetch#interceptors
 */
export function daemonErrorInterceptor(
  error: unknown,
  response: Response | undefined,
  _request: Request | undefined,
  options: { throwOnError?: boolean },
): unknown {
  if (!options.throwOnError) {
    return error;
  }
  if (error instanceof ApiError) {
    return error;
  }
  if (!response || response.ok) {
    return error;
  }
  return toApiError(error, response);
}

// Register the post-resume counting window here, alongside the interceptors
// that feed it. `main.tsx` imports this module for its side effects before
// React renders, so the counter's `app.resume` handler lands ahead of every
// subscriber the React tree adds and the requests they fire synchronously on
// resume are counted. See the function's docstring for why a React effect
// cannot give that guarantee.

daemonClient.interceptors.request.use(daemonRequestInterceptor);
daemonClient.interceptors.error.use(daemonErrorInterceptor);

// Gateway client uses the same routing as daemon: all gateway endpoints
// are proxied through the same self-hosted ingress / platform gateway path.
// Gateway-only responses do not prove daemon readiness.
gatewayClient.interceptors.request.use(gatewayRequestInterceptor);
gatewayClient.interceptors.error.use(daemonErrorInterceptor);

// Force JSON body parsing for all three generated clients. The default
// `parseAs: 'auto'` infers the parsing strategy from the Content-Type
// response header. When the header is absent (observed on iOS WKWebView
// under concurrent fetch load), the client falls back to `'stream'`
// mode and returns `response.body` (a ReadableStream or null) as
// `data` — producing the "body=null" errors reported in LUM-2371.
//
// Every endpoint in these OpenAPI specs returns JSON; non-JSON call
// sites (blob downloads) explicitly override `parseAs` per-request.
//
// Reference: https://heyapi.dev/openapi-ts/clients/fetch#parser
for (const apiClient of [daemonClient, gatewayClient, operatorClient]) {
  apiClient.setConfig({ parseAs: "json" });
}

for (const apiClient of [operatorClient]) {
  apiClient.interceptors.request.use(requestInterceptor);
}
