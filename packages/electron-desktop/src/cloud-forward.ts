/**
 * The desktop protocol handler's cloud-API proxy: `/v1/*`, `/_allauth/*`,
 * and `/accounts/*` requests forward through one `forwardCloudRequest`
 * call. The cloud's login surfaces (`/_allauth`, `/accounts`) always
 * ride the cloud, while same-origin `/v1/*` rides the active local
 * assistant's gateway when one is set — the same contract the CLI edge
 * implements by proxying `/v1` there — and the cloud otherwise. Gateway
 * destinations get the caller's guardian bearer injected server-side
 * (`gatewayBearer`): the gateway's edge auth demands it and the renderer
 * never sees the token. Unsafe requests forward only when their
 * browser-controlled `Origin` or `Referer` matches the trusted renderer
 * origin. The `fetcher` is the
 * caller's `net.fetch` — the process-boundary seam tests record (bun
 * cannot import Electron's API at module scope, so the module itself
 * stays Electron-free).
 */

export interface CloudForwardRequest {
  url: string;
  method: string;
  headers: Headers;
  body?: Request["body"];
}

export interface CloudForwardAllowedOrigin {
  protocol: string;
  host: string;
}

/** Injectable stand-in for Electron's `net.fetch`. */
export type CloudForwardFetcher = (
  url: string,
  init: RequestInit & { duplex?: "half" },
) => Promise<Response>;

export interface ForwardCloudRequestArgs {
  /** The renderer request received by the protocol handler. */
  request: CloudForwardRequest;
  /** Login surfaces (`/_allauth`, `/accounts`) always forward here. */
  cloudBase: string;
  /** Same-origin `/v1/*` forwards here when set, the cloud otherwise. */
  gatewayBase?: string;
  /**
   * Guardian bearer stamped onto gateway-bound forwards — the paired arm's
   * `getPairedGuardianAccessToken` equivalent for the local assistant's
   * gateway, whose edge auth demands the bearer. Any inbound
   * `Authorization` is replaced; the token never reaches the renderer.
   */
  gatewayBearer?: string;
  allowedOrigin?: CloudForwardAllowedOrigin;
  /** The caller's `net.fetch`; tests inject a recorder. */
  fetcher: CloudForwardFetcher;
  /** Extra attempts after the first failure. */
  retries?: number;
  retryDelayMs?: number;
  /**
   * Receives one line per failed attempt; the module owns the wording AND
   * the level — transient net errors (likely self-healing) log as
   * warnings, everything else as errors.
   */
  log?: CloudForwardLogger;
}

export interface CloudForwardLogger {
  error: (...args: unknown[]) => void;
  /** Absent loggers fall back to `error` for the transient arm. */
  warning?: (...args: unknown[]) => void;
}

const AUTH_PREFIXES = ["/_allauth", "/accounts"] as const;
const CLOUD_PREFIXES = ["/v1", ...AUTH_PREFIXES] as const;
const ELECTRON_RENDERER_ORIGIN_HEADER = "X-Cadet-Electron-Renderer-Origin";

function isCloudPath(pathname: string): boolean {
  return CLOUD_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function isAuthPath(pathname: string): boolean {
  return AUTH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function isAllowedSource(
  value: string | null,
  allowed: CloudForwardAllowedOrigin,
): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === allowed.protocol && parsed.host === allowed.host;
  } catch {
    return false;
  }
}

function isUnsafeMethod(method: string): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

function expectedRendererOrigin(allowed: CloudForwardAllowedOrigin): string {
  return `${allowed.protocol}//${allowed.host}`;
}

/**
 * Chromium omits the `Origin` header on requests to Electron custom protocol
 * handlers (`app://`), so standard origin-checking cannot trust them. Fall
 * back to two signals that ARE present:
 *
 *   1. `X-Cadet-Electron-Renderer-Origin` — set by the renderer's API
 *      interceptor on mutating requests, stripped before forwarding.
 *   2. `Sec-Fetch-Site: same-origin` — browser-controlled Fetch Metadata
 *      header that page JS cannot forge.
 *
 * Both checks additionally verify the request URL itself targets the
 * expected app origin, preventing a hypothetical cross-origin sub-resource
 * from satisfying the check.
 */
function hasTrustedSourceLessRendererSignal(
  requestUrl: URL,
  headers: Headers,
  allowed: CloudForwardAllowedOrigin,
): boolean {
  if (
    requestUrl.protocol !== allowed.protocol ||
    requestUrl.host !== allowed.host
  ) {
    return false;
  }

  if (
    headers.get(ELECTRON_RENDERER_ORIGIN_HEADER) ===
    expectedRendererOrigin(allowed)
  ) {
    return true;
  }

  return headers.get("sec-fetch-site") === "same-origin";
}

function getInitiatorTrust(
  requestUrl: URL,
  headers: Headers,
  allowed?: CloudForwardAllowedOrigin,
): { trusted: boolean; rejected: boolean } {
  if (!allowed) return { trusted: false, rejected: false };

  const origin = headers.get("origin");
  if (origin) {
    const trusted = isAllowedSource(origin, allowed);
    return { trusted, rejected: !trusted };
  }

  const referer = headers.get("referer");
  if (!referer) {
    return {
      trusted: hasTrustedSourceLessRendererSignal(requestUrl, headers, allowed),
      rejected: false,
    };
  }

  const trusted = isAllowedSource(referer, allowed);
  return { trusted, rejected: !trusted };
}

type CloudForwardPlan =
  | { kind: "pass" }
  | { kind: "reject"; status: number; message: string }
  | {
      kind: "forward";
      url: string;
      method: string;
      headers: Headers;
      hasBody: boolean;
    };

/**
 * Resolve a renderer request to a cloud-proxy plan.
 *
 * On `forward`, the request's `Origin` is rewritten to the target's own
 * origin. The renderer issues this request from `app://mycadet.ai` but the
 * target expects its own origin for CORS purposes — the gateway's token
 * route, for one, only accepts loopback web origins. Unsafe requests are
 * only forwarded when their browser-controlled `Origin` or `Referer`
 * matches the trusted renderer origin. All other headers pass through
 * unchanged.
 */
function planCloudForward(
  request: CloudForwardRequest,
  targets: Pick<
    ForwardCloudRequestArgs,
    "cloudBase" | "gatewayBase" | "gatewayBearer"
  >,
  allowedOrigin?: CloudForwardAllowedOrigin,
): CloudForwardPlan {
  const url = new URL(request.url);
  if (!isCloudPath(url.pathname)) {
    return { kind: "pass" };
  }

  const initiator = getInitiatorTrust(url, request.headers, allowedOrigin);
  const unsafeUntrustedRequest =
    allowedOrigin && isUnsafeMethod(request.method) && !initiator.trusted;
  if (initiator.rejected || unsafeUntrustedRequest) {
    return {
      kind: "reject",
      status: 403,
      message: "Forbidden cloud proxy request",
    };
  }

  const authPath = isAuthPath(url.pathname);
  const base = authPath
    ? targets.cloudBase
    : (targets.gatewayBase ?? targets.cloudBase);
  const target = new URL(base);
  const headers = new Headers(request.headers);
  headers.delete(ELECTRON_RENDERER_ORIGIN_HEADER);
  headers.set("origin", target.origin);
  if (!authPath && targets.gatewayBase && targets.gatewayBearer) {
    headers.delete("authorization");
    headers.set("authorization", `Bearer ${targets.gatewayBearer}`);
  }

  return {
    kind: "forward",
    url: `${target.origin}${url.pathname}${url.search}`,
    method: request.method,
    headers,
    hasBody: request.method !== "GET" && request.method !== "HEAD",
  };
}

/**
 * Error code carried in the JSON body of a proxy-synthesized 502 so the
 * renderer can tell "the proxy's own `net.fetch` failed" apart from a real
 * cloud answer. Mirrors `PROXY_NETWORK_ERROR_CODE` in
 * `clients/web/src/assistant/lifecycle.ts`; the two must stay in sync, but
 * there is no shared package between the renderer and the Electron main
 * bundle to host the constant.
 */
export const PROXY_NETWORK_ERROR_CODE = "proxy_network_error";

/** Marker header on proxy-synthesized error responses. */
export const PROXY_ERROR_HEADER = "X-Cadet-Proxy-Error";

const PROXY_NETWORK_ERROR_DETAIL =
  "Couldn't reach Cadet. Check your internet connection and try again.";

/**
 * Chromium net-stack failures that resolve on their own within seconds —
 * the classic case is `ERR_NETWORK_CHANGED` while Wi-Fi reassociates after
 * sleep/wake (LUM-2402). Worth a quick in-proxy retry before bothering the
 * renderer.
 */
const TRANSIENT_NET_ERROR_CODES = [
  "ERR_NETWORK_CHANGED",
  "ERR_INTERNET_DISCONNECTED",
  "ERR_NAME_NOT_RESOLVED",
  "ERR_CONNECTION_RESET",
] as const;

export function isTransientNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return TRANSIENT_NET_ERROR_CODES.some((code) => err.message.includes(code));
}

/**
 * The 502 returned when the proxy's own `net.fetch` rejected. Structured
 * (JSON `detail` + `code`, marker header) instead of the raw Chromium
 * message so the renderer never renders `net::ERR_*` strings and can
 * classify the failure as transport-shaped.
 */
export function buildProxyNetworkErrorResponse(): Response {
  return new Response(
    JSON.stringify({
      detail: PROXY_NETWORK_ERROR_DETAIL,
      code: PROXY_NETWORK_ERROR_CODE,
    }),
    {
      status: 502,
      headers: {
        "Content-Type": "application/json",
        [PROXY_ERROR_HEADER]: "network",
      },
    },
  );
}

export interface ForwardFetchRetryOptions {
  /** Extra attempts after the first failure. */
  retries?: number;
  retryDelayMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Per-failure observer (logging); receives every rejected attempt. */
  onError?: (err: unknown, attempt: number) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run a forward plan's fetch with retry-on-transient-failure semantics.
 * Only bodiless idempotent requests (GET/HEAD) retry — anything with a
 * body streams `request.body`, which is single-use, and non-idempotent
 * methods must not be silently replayed. Exhausted or non-transient
 * failures collapse into the structured 502 instead of rejecting, so the
 * protocol handler never propagates a raw error to the renderer.
 */
export async function fetchForwardPlanWithRetry(
  plan: { method: string; hasBody: boolean },
  doFetch: () => Promise<Response>,
  options: ForwardFetchRetryOptions = {},
): Promise<Response> {
  const {
    retries = 2,
    retryDelayMs = 500,
    sleep = defaultSleep,
    onError,
  } = options;
  const retryable =
    !plan.hasBody && ["GET", "HEAD"].includes(plan.method.toUpperCase());

  for (let attempt = 0; ; attempt++) {
    try {
      return await doFetch();
    } catch (err) {
      onError?.(err, attempt);
      const canRetry =
        retryable && attempt < retries && isTransientNetworkError(err);
      if (!canRetry) return buildProxyNetworkErrorResponse();
      await sleep(retryDelayMs);
    }
  }
}

/**
 * Forward a cloud-path renderer request to its resolved target, or
 * return `null` for non-cloud paths (the protocol handler falls
 * through to static serving). The fetch runs through the injected
 * `fetcher` — `net.fetch` in main, a recorder in tests — so the
 * renderer stays same-origin.
 */
export async function forwardCloudRequest(
  args: ForwardCloudRequestArgs,
): Promise<Response | null> {
  const plan = planCloudForward(
    args.request,
    args,
    args.allowedOrigin,
  );
  switch (plan.kind) {
    case "pass":
      return null;
    case "reject":
      return new Response(plan.message, { status: plan.status });
    case "forward":
      return fetchForwardPlanWithRetry(
        plan,
        () =>
          args.fetcher(plan.url, {
            method: plan.method,
            headers: plan.headers,
            body: plan.hasBody ? args.request.body : undefined,
            ...(plan.hasBody ? { duplex: "half" as const } : {}),
            redirect: "manual",
            credentials: "omit",
          }),
        {
          retries: args.retries,
          retryDelayMs: args.retryDelayMs,
          onError: (err, attempt) => {
            const line = `[cloud-forward] fetch failed (attempt ${attempt + 1}) for ${plan.method} ${plan.url}:`;
            if (isTransientNetworkError(err) && args.log?.warning) {
              args.log.warning(line, err);
            } else {
              args.log?.error(line, err);
            }
          },
        },
      );
  }
}
