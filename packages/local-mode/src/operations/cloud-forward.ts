import { cloudOrigin } from "./cloud-proxy";
import type { OperatorRequest } from "./routes";

/**
 * The operator's CLOUD ARM: what the route table's rows don't claim, the
 * cloud answers. The renderer's auth is same-origin naive (the generated
 * allauth SDK speaks `/_allauth`, `/accounts` hosts the full-page flows,
 * and the releases catalog is the cloud's own read, auth riding the
 * caller's own headers) — the hosts that re-origin those paths forward
 * them here.
 */
const CLOUD_PREFIXES = ["/_allauth", "/accounts", "/v1/releases"] as const;

/**
 * The cloud arm's row pattern: the OR-union of the cloud's own prefixes —
 * the arm is just another operator row, last in match order, so the
 * dispatcher has no special-cased cloud tail.
 */
export const CLOUD_ARM_PATTERN = new RegExp(
  `^(?:${CLOUD_PREFIXES.map((prefix) => prefix.replace(/\//g, "\\/")).join("|")})(?:$|/)`,
);

export function isCloudPath(pathname: string): boolean {
  return CLOUD_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * Error code carried in the JSON body of an arm-synthesized 502 so the
 * renderer can tell "the proxy's own fetch failed" apart from a real
 * cloud answer. Mirrors the transport-error handling in the renderer
 * bundles — the two must stay in sync; no renderer-importable package
 * exists to host one constant.
 */
export const PROXY_NETWORK_ERROR_CODE = "proxy_network_error";

/** Marker header on arm-synthesized error responses. */
export const PROXY_ERROR_HEADER = "X-Cadet-Proxy-Error";

const PROXY_NETWORK_ERROR_DETAIL =
  "Couldn't reach Cadet. Check your internet connection and try again.";

/**
 * Chromium net-stack failures that resolve on their own within seconds —
 * the classic case is `ERR_NETWORK_CHANGED` while Wi-Fi reassociates after
 * sleep/wake (LUM-2402). Worth a quick in-arm retry before bothering the
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
 * The 502 returned when the arm's own fetch rejected. Structured (JSON
 * `detail` + `code`, marker header) instead of the raw Chromium message
 * so the renderer never renders `net::ERR_*` strings and can classify the
 * failure as transport-shaped.
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

/**
 * The cloud arm's run — the caller's request rides to the cloud verbatim
 * (same-origin origin stamp, transient-retry, structured 502).
 */
export async function forwardCloudRequest(
  request: OperatorRequest,
): Promise<Response | null> {
  const target = cloudOrigin();
  const headers = new Headers(request.headers);
  headers.set("origin", new URL(target).origin);
  const forwardUrl = `${target}${request.path}`;
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const retryable =
    !hasBody && ["GET", "HEAD"].includes(request.method.toUpperCase());

  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(forwardUrl, {
        method: request.method,
        headers,
        body: hasBody ? request.body : undefined,
        ...(hasBody ? { duplex: "half" as const } : {}),
        signal: request.signal ?? undefined,
        redirect: "manual",
      });
    } catch (err) {
      const line = `[cloud-forward] fetch failed (attempt ${attempt + 1}) for ${request.method} ${forwardUrl}:`;
      if (isTransientNetworkError(err)) {
        console.warn(line, err);
      } else {
        console.error(line, err);
      }
      if (retryable && attempt < 2 && isTransientNetworkError(err)) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }
      return buildProxyNetworkErrorResponse();
    }
  }
}
