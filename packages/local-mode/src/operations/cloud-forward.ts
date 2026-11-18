import { cloudOrigin } from "./cloud-proxy";
import type { Fetch } from "@mycadet/shared/fetch";

/**
 * The operator's PLATFORM ARM: what the route table's rows don't claim,
 * the cloud answers. The renderer's API surface is same-origin naive —
 * the generated allauth SDK speaks `/_allauth`, and the web bundle's SDK
 * speaks `/v1` user surfaces (organizations, billing, MFA, releases) and
 * `/accounts` full-page flows — on whatever origin serves it. Hosts that
 * serve that origin themselves (the CLI edge on loopback, the cloud's own
 * web serving) need nothing; the one host that re-origins everything (the
 * desktop's `app://` pass) forwards those paths here, where the target
 * resolves through the same `getCloudBaseUrl` every operator cloud dial
 * reads — a self-hosted app server re-points all of them in one place.
 *
 * The arm is the dispatcher's fallthrough (unmatched paths, and rows that
 * pass — the stale-id 404 the route table documents), gated to the cloud's
 * path prefixes so static and asset surfaces never reach it.
 *
 * Trust: an unsafe request forwards only when it is same-origin
 * authentic. Chromium omits the `Origin` header on requests to Electron
 * custom protocol handlers (`app://`), so standard origin-checking cannot
 * trust them; the fallback signals ARE present:
 *
 *   1. `X-Cadet-Electron-Renderer-Origin` — set by the renderer's API
 *      interceptor on mutating requests, stripped before forwarding. (A
 *      cross-origin forger could set it too, but the custom header forces
 *      a CORS preflight the cloud refuses for foreign origins.)
 *   2. `Sec-Fetch-Site: same-origin` — browser-controlled Fetch Metadata
 *      that page JS cannot forge.
 *
 * Everything checks against the REQUEST's own origin — the arm never
 * learns a topology.
 */
const CLOUD_PREFIXES = ["/v1", "/_allauth", "/accounts"] as const;
const RENDERER_ORIGIN_HEADER = "X-Cadet-Electron-Renderer-Origin";

export function isCloudPath(pathname: string): boolean {
  return CLOUD_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function isUnsafeMethod(method: string): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
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
 * The initiator-trust verdict for an unsafe request: `trusted` forwards,
 * `untrusted` falls through to the sourceless signals (Chromium's missing
 * `Origin` case), `rejected` answers 403 — a PRESENT Origin or Referer
 * that names a DIFFERENT origin is itself the attack signal.
 */
function getInitiatorTrust(
  url: URL,
  headers: Headers,
): "trusted" | "untrusted" | "rejected" {
  const source = headers.get("origin") ?? headers.get("referer");
  if (source !== null) {
    return isSameOriginSource(source, url) ? "trusted" : "rejected";
  }
  const sourceless =
    headers.get(RENDERER_ORIGIN_HEADER) === `${url.protocol}//${url.host}` ||
    headers.get("sec-fetch-site") === "same-origin";
  return sourceless ? "trusted" : "untrusted";
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
 * The platform arm for one dispatcher pass: `null` when the path isn't a
 * cloud surface (the host's own chain — assets, static — answers), the
 * cloud's answer otherwise. The dial rides the host's `fetch` when it
 * brings one (the desktop's `net.fetch`: the main process's network
 * stack, system proxy and cert store), the ambient one otherwise.
 * Best-effort retries cover the transient net errors; exhausted or
 * non-transient failures collapse into the structured 502 instead of
 * rejecting, so the dispatcher never propagates a raw error to a
 * renderer. Only bodiless idempotent requests retry — anything with a
 * body streams `request.body`, which is single-use, and non-idempotent
 * methods must not be silently replayed.
 */
export async function runCloudForwardArm(
  request: Request,
  fetcher?: Fetch,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!isCloudPath(url.pathname)) {
    return null;
  }

  const unsafe = isUnsafeMethod(request.method);
  if (unsafe && getInitiatorTrust(url, request.headers) !== "trusted") {
    return new Response("Forbidden cloud proxy request", { status: 403 });
  }

  const target = cloudOrigin();
  const headers = new Headers(request.headers);
  headers.delete(RENDERER_ORIGIN_HEADER);
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
        // Flagged for a later call: with `omit`, the allauth session
        // cookies never store on the dialing host — the desktop's shells
        // hold tokens in their own vaults instead. The cookie jar could
        // carry them for the cloud origin the same way it carries the
        // gateway pair, when managed-mode custody is wanted.
        credentials: "omit",
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
