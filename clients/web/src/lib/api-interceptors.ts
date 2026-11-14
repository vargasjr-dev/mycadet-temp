/**
 * Request/response interceptors for the generated HeyAPI clients.
 *
 * For daemon + gateway requests, attaches:
 *   - `X-Cadet-Client-Id` + `X-Cadet-Interface-Id` — identify the
 *     originating tab/interface to the daemon. Required by self-echo
 *     suppression: the daemon echoes the client id back on the resulting
 *     `sync_changed` so the originator's SSE subscriber can be skipped.
 *   - `Cadet-Device-Id` + the Electron renderer-origin marker on mutating
 *     requests — the daemon's platform-path identity.
 *
 * Import this module for its side effects in the app entrypoint
 * (`boot.tsx`) so interceptors are installed before any API call fires.
 *
 * There is no cloud client here: the web bundle dials the serving host
 * same-origin (cookies or proxy-injected credentials), and the one
 * direct-to-cloud dial (feedback) builds its own URL with
 * {@link getCloudBaseUrl}.
 *
 * Reference: https://heyapi.dev/openapi-ts/clients/fetch#interceptors
 */
import { client as daemonClient } from "@/generated/daemon/client.gen";
import { client as gatewayClient } from "@/generated/gateway/client.gen";
import { ApiError, toApiError } from "@/utils/api-errors";
import { currentLocale } from "@/i18n";
import { getClientRegistrationHeaders } from "@/lib/client-identity";
import { getDeviceId } from "@/runtime/device-id";
import { isElectron } from "@/runtime/is-electron";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const ELECTRON_RENDERER_ORIGIN_HEADER = "X-Cadet-Electron-Renderer-Origin";

function getRendererTupleOrigin(): string {
  return `${window.location.protocol}//${window.location.host}`;
}

/**
 * Builds a request interceptor for a HeyAPI client. Every remaining
 * generated client targets the self-hosted daemon (directly or through
 * the gateway ingress), so all assistant sub-resource paths ride the
 * same stamping.
 */
function createRequestInterceptor() {
  const route = async (request: Request): Promise<Request> => {
    const newRequest = new Request(request);

    // Per-tab client identity — sent on *every* request (GET included)
    // so SSE-via-fetch readers and short-lived mutations carry the same
    // id.
    for (const [name, value] of Object.entries(
      getClientRegistrationHeaders(),
    )) {
      newRequest.headers.set(name, value);
    }

    newRequest.headers.set("Accept-Language", currentLocale());

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

    return newRequest;
  };

  return async (request: Request): Promise<Request> => {
    return route(request);
  };
}

/** Shared by the daemon and gateway clients. */
export const daemonRequestInterceptor = createRequestInterceptor();

const gatewayRequestInterceptor = createRequestInterceptor();

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

// Force JSON body parsing for both generated clients. The default
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
for (const apiClient of [daemonClient, gatewayClient]) {
  apiClient.setConfig({ parseAs: "json" });
}
