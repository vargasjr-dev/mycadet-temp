/**
 * Request/response interceptors for the generated HeyAPI clients.
 *
 * For platform-bound requests, attaches:
 *   - `Cadet-Organization-Id` — selects the active org server-side.
 *   - `X-CSRFToken` (mutations only) — required by the cloud's
 *     SessionAuthentication.
 *   - `X-Cadet-Client-Id` + `X-Cadet-Interface-Id` — identify the
 *     originating tab/interface to the daemon. Required by self-echo
 *     suppression: the daemon echoes the client id back on the resulting
 *     `sync_changed` so the originator's SSE subscriber can be skipped.
 *
 * When `getSelfHostedIngressUrl()` returns a URL AND the request hits a
 * runtime-proxied per-assistant path, {@link rewriteForSelfHostedIngress}
 * takes over instead — the URL's origin is swapped to the ingress, the
 * platform-only headers are stripped, cookie credentials are omitted,
 * and an `Authorization: Bearer` is attached when
 * `getSelfHostedActorToken()` returns a value (it can briefly return
 * `null` while `bootstrap_platform_actor_token` is mid-flight on the
 * platform — the gateway then 401s and the chat surface lands on its
 * error state).
 *
 * Import this module for its side effects in the app entrypoint
 * (`main.tsx`) so interceptors are installed before any API call fires.
 *
 * Reference: https://heyapi.dev/openapi-ts/clients/fetch#interceptors
 */
import { client as cloudClient } from "@/generated/api/client.gen";
import { client as authClient } from "@/generated/auth/client.gen";
import { client as daemonClient } from "@/generated/daemon/client.gen";
import { client as gatewayClient } from "@/generated/gateway/client.gen";
import { getCloudRuntimeUrl } from "@/lib/cloud-runtime-url";
import { getCsrfToken } from "@/lib/auth/csrf";
import { ApiError, toApiError } from "@/utils/api-errors";
import { FLATTENED_FIRST_SEGMENTS } from "@mycadet/local-mode/contract";
import {
  isLocalClient,
  isCadetCloudRemote,
  isServedGatewayRuntime,
} from "@/lib/local-mode";
import {
  getSelfHostedActorToken,
  getSelfHostedIngressUrl,
} from "@/lib/self-hosted/connection";
import { currentLocale } from "@/i18n";
import { getClientRegistrationHeaders } from "@/lib/client-identity";
import { getDeviceId } from "@/runtime/device-id";
import { isElectron } from "@/runtime/is-electron";
import { getElectronSessionToken } from "@/runtime/session-token";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const ELECTRON_RENDERER_ORIGIN_HEADER = "X-Cadet-Electron-Renderer-Origin";
const NGROK_SKIP_BROWSER_WARNING_HEADER = "ngrok-skip-browser-warning";

function getRendererTupleOrigin(): string {
  return `${window.location.protocol}//${window.location.host}`;
}

/**
 * Allowlist of `/v1/assistants/{id}/<segment>/...` first segments that
 * the **platform client** rewrites to the self-hosted gateway.
 *
 * Only applies to requests made through the cloud HeyAPI client.
 * The daemon client bypasses this list entirely — all daemon SDK
 * requests are forwarded to the gateway unconditionally (see
 * {@link daemonRequestInterceptor}).
 *
 * Kept narrow for the cloud client: the cloud owns routes like
 * `system-events/`, `terminal/`, `doctor/` under
 * the same namespace, and forwarding those to the gateway would 404.
 * Once all daemon endpoints are migrated to the daemon SDK, this list
 * becomes dead code and can be removed.
 */
const RUNTIME_PROXIED_FIRST_SEGMENTS = new Set<string>([
  "conversations",
  // Live SSE event stream — `subscribeEvents` opens it through the
  // platform client, so it must be forwarded to the gateway in local /
  // self-hosted mode like any other runtime route.
  "events",
  // User-defined route handlers (`/v1/x/*`). Sandboxed apps reach their
  // backend handlers through the cloud client (the sandbox fetch
  // proxy in `useSandboxFetchProxy`, gated to `/v1/x/` paths), so these
  // must be forwarded to the gateway in local / self-hosted mode rather
  // than falling through to the cloud proxy.
  "x",
  // Daemon-owned app-serving routes (`/v1/apps/*`: bundled asset media and
  // compiled dist files). The sandbox asset proxy in `useSandboxFetchProxy`
  // fetches `/v1/assistants/{id}/apps/{appId}/asset/...` through the cloud
  // client, so it must be forwarded to the gateway in local / self-hosted
  // mode rather than falling through to the cloud proxy.
  "apps",
  // Daemon-owned config reached through the cloud client via raw
  // `client.*` calls (the background `TimezoneSync` PATCH and the general
  // settings page). Must be forwarded to the gateway in local /
  // self-hosted mode rather than falling through to the dead platform
  // proxy — otherwise the PATCH retries against a nonexistent platform
  // and floods the console with 502s. Removable once those call sites
  // move to the generated daemon SDK (LUM-2716).
  //
  // Every removed entry (contacts, trust-rules, permissions,
  // channel-admission-policy, …) was retired by migrating its call sites
  // to the generated gateway SDK, whose client forwards all
  // assistant-scoped requests without this list: that is the paved road
  // for new endpoints. Deliberately NOT listed: `artifacts` (no
  // gateway/daemon route exists) and
  // `push-tokens` / `live-activity` (cloud-owned token registration).
  // Those stay on the cloud in cloud and local-with-ingress. Remote
  // gateway authorizes the last two via
  // {@link authorizeRemoteGatewayRequest} so the features gate does not
  // abort them. The contact family (`contacts`, `contact-channels`) is
  // forwarded via {@link FLATTENED_FIRST_SEGMENTS} with the assistant
  // prefix stripped; it does not belong in this allowlist.
  "config",
]);

/**
 * Cloud-owned device and Live Activity token routes. In remote-gateway
 * mode they are same-origin to the ingress, so they must carry the
 * paired bearer or {@link platformFeaturesGate} aborts them before
 * The cloud (or the gateway proxy that reaches it) sees them.
 */
const PLATFORM_PUSH_FIRST_SEGMENTS = new Set<string>([
  "push-tokens",
  "live-activity",
]);

const ASSISTANT_PATH_RE = /^\/v1\/assistants\/[^/]+\/(([^/?#]+)(?:\/.*)?)$/;

/**
 * Same resource match as {@link ASSISTANT_PATH_RE}, but allows an ingress
 * path prefix (`/assistant-123/v1/assistants/...`).
 */
const ASSISTANT_RESOURCE_RE = /\/v1\/assistants\/[^/]+\/(([^/?#]+)(?:\/.*)?)$/;

function currentSelfHostedBearer(): string | null {
  const token = getSelfHostedActorToken();
  return token ? `Bearer ${token}` : null;
}

/**
 * Stamp the current self-hosted actor token as the request's bearer, or
 * strip any bearer a caller happened to set when there is none. Without a
 * token the gateway must see an unauthenticated request and answer 401, so
 * the chat surface lands on its error state rather than spinning on a
 * stale credential.
 */
function applySelfHostedBearer(headers: Headers): void {
  const authorization = currentSelfHostedBearer();
  if (authorization) {
    headers.set("Authorization", authorization);
  } else {
    headers.delete("Authorization");
  }
}

function isPlatformPushPath(url: string): boolean {
  const match = ASSISTANT_RESOURCE_RE.exec(new URL(url).pathname);
  return match !== null && PLATFORM_PUSH_FIRST_SEGMENTS.has(match[2]);
}

/**
 * Platform clients emit `/v1/assistants/...` against the page origin. A
 * path-prefixed remote ingress only serves `/assistant-123/v1/...`, so
 * relocate the resource under that prefix before authorizing.
 */
function relocateRemoteGatewayPushRequest(request: Request): Request {
  if (!isServedGatewayRuntime()) {
    return request;
  }
  const ingressUrl = getSelfHostedIngressUrl();
  if (!ingressUrl) {
    return request;
  }

  const url = new URL(request.url);
  const ingress = new URL(ingressUrl);
  if (url.origin !== ingress.origin) {
    return request;
  }

  const resource = ASSISTANT_RESOURCE_RE.exec(url.pathname);
  if (!resource || !PLATFORM_PUSH_FIRST_SEGMENTS.has(resource[2])) {
    return request;
  }

  const prefix = ingress.pathname.replace(/\/$/, "");
  const relocatedPath = `${prefix}${resource[0]}`;
  if (url.pathname === relocatedPath) {
    return request;
  }

  const relocated = new URL(request.url);
  relocated.pathname = relocatedPath;
  return new Request(relocated.toString(), request);
}

/**
 * Rewrites a request bound for `/v1/assistants/{id}/{runtime-segment}/...`
 * to the registered self-hosted ingress, swapping platform session/CSRF
 * auth for `Authorization: Bearer <jwt>`.
 *
 * Returns `null` when no self-hosted ingress is currently set or when
 * the path doesn't match an assistant sub-resource.
 *
 * @param request — the outbound request to inspect.
 * @param options.skipSegmentAllowlist — when `true`, all assistant
 *   sub-resource paths are forwarded regardless of
 *   {@link RUNTIME_PROXIED_FIRST_SEGMENTS}. The daemon client sets this
 *   for both daemon routes and gateway-owned compatibility routes.
 *   The cloud client leaves it `false` to avoid forwarding
 *   platform-owned routes (system-events, etc.);
 *   {@link FLATTENED_FIRST_SEGMENTS} are forwarded regardless.
 *
 * Exported for direct unit testing — production code paths invoke this
 * via {@link requestInterceptor} / {@link daemonRequestInterceptor}.
 */
export async function rewriteForSelfHostedIngress(
  request: Request,
  { skipSegmentAllowlist = false } = {},
): Promise<Request | null> {
  const ingressUrl = getSelfHostedIngressUrl();
  if (!ingressUrl) {
    return null;
  }

  const url = new URL(request.url);

  const match = ASSISTANT_PATH_RE.exec(url.pathname);
  if (!match) {
    return null;
  }
  const [, subPath, firstSegment] = match;
  if (
    !skipSegmentAllowlist &&
    !RUNTIME_PROXIED_FIRST_SEGMENTS.has(firstSegment) &&
    !FLATTENED_FIRST_SEGMENTS.has(firstSegment)
  ) {
    return null;
  }

  // Splice the cloud's base out and the user's gateway in. Contact-family
  // paths are flattened to `/v1/<rest>` — the shape cloud's runtime proxy strip
  // delivers to the gateway, which serves them on its flat control-plane
  // routes. Every other segment keeps the scoped path verbatim: the gateway
  // exposes the same `/v1/assistants/{id}/...` routes the cloud's
  // RuntimeProxyView would otherwise forward to.
  const rewrittenUrl = new URL(ingressUrl);
  const prefix = rewrittenUrl.pathname.replace(/\/$/, "");
  rewrittenUrl.pathname = FLATTENED_FIRST_SEGMENTS.has(firstSegment)
    ? `${prefix}/v1/${subPath}`
    : prefix + url.pathname;
  rewrittenUrl.search = url.search;

  // Build a fresh header set. Drop platform-only headers; keep client +
  // interface ids so the user's gateway can echo them back for self-echo
  // suppression once the SSE wiring lands on the same path.
  const headers = new Headers(request.headers);
  headers.delete("X-CSRFToken");
  headers.delete("Cadet-Organization-Id");
  if (isServedGatewayRuntime()) {
    // Ngrok free tunnels return an HTML interstitial to browser-shaped API
    // requests unless this bypass header is present.
    headers.set(NGROK_SKIP_BROWSER_WARNING_HEADER, "true");
  }

  applySelfHostedBearer(headers);

  // In local mode the gateway proxy runs over plain HTTP, and Chrome
  // refuses to send a streaming (duplex: "half") body without TLS
  // (ERR_ALPN_NEGOTIATION_FAILED), so the body must be buffered into a
  // finite-length payload. Buffer to a Blob rather than an ArrayBuffer:
  // an ArrayBuffer body is streamed to the network process through a
  // fixed-capacity (~1-2 MB) data pipe, so a larger upload stalls forever
  // when the local consumer drains the pipe slowly. A Blob is passed by
  // reference (blob handle) and read directly, with no renderer-side data
  // pipe to block on. Platform self-hosted uses TLS, so keep the streaming
  // body there to avoid buffering large uploads.
  const body = isLocalClient()
    ? request.body
      ? await request.blob()
      : null
    : request.body;

  const init: RequestInit = {
    method: request.method,
    headers,
    body,
    // Bearer auth replaces cookie auth — don't leak the cloud's
    // session cookie to the user's gateway.
    credentials: "omit",
    redirect: request.redirect,
    signal: request.signal,
    // A rebuilt Request does not inherit this from `request`, and dropping it
    // cancels pagehide-time sends (the boot telemetry flush) mid-navigation.
    keepalive: request.keepalive,
  };
  if (!isLocalClient() && request.body) {
    (init as RequestInit & { duplex: "half" }).duplex = "half";
  }
  return new Request(rewrittenUrl.toString(), init);
}

/**
 * Remote-gateway mode serves the app and the gateway from the same nginx edge.
 * Some platform-generated clients still call same-origin flat `/v1/...` routes
 * (for example client feature flags), so they do not pass through the
 * `/v1/assistants/{id}/...` self-hosted rewrite above. Treat those as gateway
 * requests too: attach the paired browser token and strip platform-only auth.
 */
export function authorizeRemoteGatewayRequest(
  request: Request,
): Request | null {
  if (!isServedGatewayRuntime()) {
    return null;
  }

  const ingressUrl = getSelfHostedIngressUrl();
  if (!ingressUrl) {
    return null;
  }

  const url = new URL(request.url);
  const ingress = new URL(ingressUrl);
  const prefix = ingress.pathname.replace(/\/$/, "");
  if (url.origin !== ingress.origin) {
    return null;
  }
  if (!url.pathname.startsWith(`${prefix}/v1/`)) {
    return null;
  }

  const headers = new Headers(request.headers);
  headers.delete("X-CSRFToken");
  headers.delete("Cadet-Organization-Id");
  headers.set(NGROK_SKIP_BROWSER_WARNING_HEADER, "true");
  applySelfHostedBearer(headers);

  return new Request(request, {
    headers,
    credentials: "omit",
  });
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

    // Self-hosted assistant + runtime-proxied path → talk to the user's
    // gateway directly instead of stamping the cloud's session/CSRF
    // headers.
    const selfHosted = await rewriteForSelfHostedIngress(newRequest, {
      skipSegmentAllowlist: isDaemonClient,
    });
    if (selfHosted) {
      return selfHosted;
    }

    if (allowRemoteGatewayDirect) {
      const remoteGateway = authorizeRemoteGatewayRequest(newRequest);
      if (remoteGateway) {
        return remoteGateway;
      }
    }

    if (!isDaemonClient && isPlatformPushPath(newRequest.url)) {
      const relocated = relocateRemoteGatewayPushRequest(newRequest);
      const remoteGateway = authorizeRemoteGatewayRequest(relocated);
      if (remoteGateway) {
        return remoteGateway;
      }
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
for (const apiClient of [
  daemonClient,
  gatewayClient,
  cloudClient,
  authClient,
]) {
  apiClient.setConfig({ parseAs: "json" });
}

authClient.setConfig({
  baseUrl: getCloudRuntimeUrl(),
  credentials: "include",
});

for (const apiClient of [authClient, cloudClient]) {
  apiClient.interceptors.request.use(requestInterceptor);
}

// A chat send in cloud mode goes through the daemon client; other platform
// calls go through the cloud client. Not installed on `authClient` — the
// allauth session endpoints manage their own 401 semantics.

/**
 * What {@link platformFeaturesGate} does with a request. A deny carries the
 * reason it was denied, so the gate reports it without re-probing the mode the
 * decision already looked at. {@link PLATFORM_GATE_DENIALS} keys off this
 * union, so a third reason cannot be mislabelled as one of the existing two.
 */
type CloudGateDecision = "allow" | "deny_remote_gateway";

/**
 * How each denial is reported. Keyed by every deny decision, so a new reason
 * added to {@link CloudGateDecision} fails to compile until it says what it
 * logs and what it aborts with.
 */
const PLATFORM_GATE_DENIALS: Record<
  Exclude<CloudGateDecision, "allow">,
  { log: string; abortMessage: string }
> = {
  deny_remote_gateway: {
    log: "remote-gateway mode, no-op platform request:",
    abortMessage: "Platform routes disabled in remote-gateway mode",
  },
};

/**
 * The decision {@link platformFeaturesGate} reaches for this request.
 *
 * Takes the request as the gate sees it: the gate is registered after
 * {@link requestInterceptor}, so a self-hosted rewrite (gateway origin, bearer
 * auth) has already happened by the time it runs.
 */
function cloudFeaturesGateDecision(request: Request): CloudGateDecision {
  if (isCadetCloudRemote()) {
    // The cloud session cookie authenticates platform-origin calls in
    // this mode; the bearer check below guards gateway-session bundles.
    return "allow";
  }
  if (isServedGatewayRuntime()) {
    // A served-gateway browser holds the gateway JWT as its credential:
    // platform-bound calls ride it as the bearer or are refused.
    const hasBearer =
      request.headers
        .get("Authorization")
        ?.toLowerCase()
        .startsWith("bearer ") ?? false;
    return hasBearer ? "allow" : "deny_remote_gateway";
  }

  return "allow";
}

/**
 * Abort platform client requests in remote-gateway mode that ride no
 * gateway bearer. Let-through requests keep the daemon endpoints
 * (skills, memories, etc.) that route through the cloud client alive.
 *
 * Exported for direct unit testing.
 */
export function platformFeaturesGate(request: Request): Request {
  const decision = cloudFeaturesGateDecision(request);
  if (decision === "allow") {
    return request;
  }

  const denial = PLATFORM_GATE_DENIALS[decision];
  console.debug(denial.log, new URL(request.url).pathname);
  const aborted = new AbortController();
  aborted.abort(new DOMException(denial.abortMessage, "AbortError"));
  return new Request(request.url, { signal: aborted.signal });
}

cloudClient.interceptors.request.use(platformFeaturesGate);
