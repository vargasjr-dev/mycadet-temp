import { cloudOrigin } from "./cloud-proxy";
import type { Fetch } from "@mycadet/shared/fetch";

/**
 * The operator's CLOUD ARM: what the route table's rows don't claim, the
 * cloud answers. The renderer's auth is same-origin naive (the generated
 * allauth SDK speaks `/_allauth`, `/accounts` hosts the full-page flows,
 * and the releases catalog is the cloud's own read, auth riding the
 * caller's own headers) — the hosts that re-origin those paths forward
 * them here.
 */
const CLOUD_PREFIXES = ["/_allauth", "/accounts", "/v1/releases"] as const;

export function isCloudPath(pathname: string): boolean {
  return CLOUD_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function isSameOriginSource(value: string | null, url: URL): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    // Protocol and host separately: `.origin` is the opaque "null" for
    // non-special schemes (`app://`), so origin-string equality can't
    // express same-source for the desktop's handler.
    return parsed.protocol === url.protocol && parsed.host === url.host;
  } catch {
    return false;
  }
}

/**
 * The initiator-trust verdict, whole request in: safe methods are
 * trivially trusted; unsafe methods trust only the unforgeable signals —
 * a PRESENT `Origin` or `Referer` must name the request's origin (the
 * browser sets both and page JS can fake neither, so a foreign value IS
 * the attack signal), and source-less requests (the desktop's renderer:
 * Chromium omits `Origin` on `app://`) trust only `sec-fetch-site:
 * same-origin` — fetch metadata the network stack computes and a page
 * cannot claim.
 */
function isTrustedRequest(req: Request): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method.toUpperCase())) {
    return true;
  }
  const url = new URL(req.url);
  const source = req.headers.get("origin") ?? req.headers.get("referer");
  if (source !== null) {
    return isSameOriginSource(source, url);
  }
  return req.headers.get("sec-fetch-site") === "same-origin";
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
 * The cloud arm for one dispatcher pass: `null` when the path isn't the
 * cloud's (the host's own chain answers), the cloud's answer otherwise.
 * The dial rides the host's `fetch` when it brings one (the desktop's
 * `net.fetch`: the main process's network stack, system proxy and cert
 * store), the ambient one otherwise. Best-effort retries cover the
 * transient net errors; exhausted or non-transient failures collapse into
 * the structured 502 instead of rejecting. Only bodiless idempotent
 * requests retry — a body streams `request.body`, which is single-use,
 * and non-idempotent methods must not be silently replayed.
 */
export async function forwardCloudRequest(
  request: Request,
  fetcher?: Fetch,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!isCloudPath(url.pathname)) {
    return null;
  }

  if (!isTrustedRequest(request)) {
    return new Response("Forbidden cloud proxy request", { status: 403 });
  }

  const target = cloudOrigin();
  const headers = new Headers(request.headers);
  headers.set("origin", new URL(target).origin);
  const forwardUrl = `${target}${url.pathname}${url.search}`;
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const retryable =
    !hasBody && ["GET", "HEAD"].includes(request.method.toUpperCase());
  const doFetch = fetcher ?? fetch;

  for (let attempt = 0; ; attempt++) {
    try {
      return await doFetch(forwardUrl, {
        method: request.method,
        headers,
        body: hasBody ? request.body : undefined,
        ...(hasBody ? { duplex: "half" as const } : {}),
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
