import {
  authorizePairedForwardHeaders,
  gatewayTargetsFromLockfile,
  readGatewayTargets,
  resolveGatewayProxyTarget,
  resolveLockfilePaths,
  sanitizePairedForwardHeaders,
  type GatewayEntryTarget,
  type PairedGuardianTokenProvider,
} from "@mycadet/local-mode";

import {
  fetchForwardPlanWithRetry,
  type ForwardFetchRetryOptions,
} from "./cloud-forward";
import { getWatchedLockfileSnapshot } from "./lockfile-watcher";
import { getPairedGuardianAccessToken } from "./local-mode";

/**
 * Planning and execution for the gateway data-plane proxy: the same-origin
 * id-keyed forward. The scoped SDK surface (`/v1/assistants/{assistantId}/*`)
 * forwards the scoped path verbatim (contact-family flattened); the legacy
 * unscoped prefix (`/assistant/__gateway/{assistantId}/*` — the `/auth/token`
 * mint, `/readyz`, the lifecycle trio) forwards the tail. The lockfile
 * resolves the id to a loopback port (locally hatched gateways) or a recorded
 * remote `runtimeUrl` (imported pairings), so the local/paired split lives
 * host-side and the renderer never encodes either.
 *
 * Lives in its own file — like `app-protocol.ts` — so the URL/header logic is
 * testable without importing `src/main/index.ts` (which evaluates the full
 * lifecycle wiring at module load) or mocking Electron's `net`. The caller in
 * `index.ts` supplies `net.fetch`; `executeGatewayForwardPlan` turns a
 * `forward` plan into a single fetch and returns its streaming `Response`
 * verbatim.
 */
export type GatewayForwardPlan =
  | { kind: "pass" }
  | { kind: "reject"; status: number; message: string }
  | {
      kind: "forward";
      url: string;
      method: string;
      headers: Headers;
      hasBody: boolean;
      assistantId: string;
      /**
       * Loopback hops propagate transport failures untouched; remote hops
       * (paired gateways reached over a tunnel) collapse them into the
       * structured proxy 502 with a bounded GET/HEAD retry.
       */
      remote: false;
      /** Loopback target port; the plan's Origin is rewritten to it. */
      target: { kind: "loopback"; port: number };
    }
  | {
      kind: "forward";
      url: string;
      method: string;
      headers: Headers;
      hasBody: boolean;
      assistantId: string;
      remote: true;
      /** Imported gateway URL bound to that assistant's guardian bearer. */
      target: { kind: "remote"; runtimeUrl: string };
    };

/**
 * Resolve a renderer request to a gateway-proxy plan, reusing the shared
 * lockfile decision so the security boundary is defined once for this handler,
 * the Vite dev proxy, and the CLI web server: only assistants the user
 * actually hatched or imported are reachable.
 *
 * On a loopback forward, the request's `Origin` is rewritten to the gateway's
 * own loopback origin. The gateway token route (`/auth/token`) only accepts
 * loopback web origins (`http(s)://localhost|127.0.0.1`) as a CSRF defense
 * against arbitrary web pages; the renderer issues this request from the
 * packaged app's `app://mycadet.ai` origin, but the main process is itself the
 * trusted loopback client making the hop — exactly as the dev server's browser
 * presents `http://localhost:<port>`. Without the rewrite the gateway rejects
 * the packaged app's origin with 403. Only `Origin` is gated, so the remaining
 * headers (notably the gateway `Authorization` bearer the renderer minted)
 * pass through unchanged.
 *
 * On a remote forward, renderer-controlled authorization and browser-ambient
 * headers (`Origin`, `Referer`, `Cookie`, `Sec-Fetch-*`) are stripped via the
 * shared `sanitizePairedForwardHeaders`, and the trusted main process installs
 * the paired assistant's guardian bearer via
 * {@link authorizeGatewayForwardPlan} before the plan executes.
 *
 * Electron's WebRequest boundary verifies the requesting frame before this
 * planner runs. The lockfile target map then constrains the destination. A
 * compromised trusted renderer retains access through the running proxy but
 * cannot read or reuse the guardian credential outside it.
 */
function planGatewayForward(
  request: Request,
  getTargets: () => Map<string, GatewayEntryTarget>,
): GatewayForwardPlan {
  const url = new URL(request.url);
  const decision = resolveGatewayProxyTarget(
    url.pathname + url.search,
    getTargets,
  );

  switch (decision.kind) {
    case "pass":
      return { kind: "pass" };
    case "reject":
      return decision;
    case "forward": {
      const headers = new Headers(request.headers);
      if (decision.target.kind === "loopback") {
        const { port } = decision.target;
        headers.set("origin", `http://127.0.0.1:${port}`);
        return {
          kind: "forward",
          url: `http://127.0.0.1:${port}${decision.path}${decision.search}`,
          method: request.method,
          headers,
          hasBody: request.method !== "GET" && request.method !== "HEAD",
          assistantId: decision.assistantId,
          remote: false,
          target: decision.target,
        };
      }
      sanitizePairedForwardHeaders(headers);
      const runtimeUrl = decision.target.runtimeUrl.replace(/\/+$/, "");
      return {
        kind: "forward",
        url: `${runtimeUrl}${decision.path}${decision.search}`,
        method: request.method,
        headers,
        hasBody: request.method !== "GET" && request.method !== "HEAD",
        assistantId: decision.assistantId,
        remote: true,
        target: decision.target,
      };
    }
  }
}

/** Resolve and install the host-owned bearer required by a remote plan. */
async function authorizeGatewayForwardPlan(
  plan: GatewayForwardPlan,
  getGuardianToken: PairedGuardianTokenProvider,
): Promise<GatewayForwardPlan> {
  if (plan.kind !== "forward" || !plan.remote) {
    return plan;
  }
  const result = await authorizePairedForwardHeaders(
    plan.assistantId,
    plan.target.runtimeUrl,
    plan.headers,
    getGuardianToken,
  );
  if (!result.ok) {
    return { kind: "reject", status: result.status, message: result.error };
  }
  return plan;
}

/** Injectable stand-in for Electron's `net.fetch`. */
export type GatewayForwardFetcher = (
  url: string,
  init: RequestInit & { duplex?: "half" },
) => Promise<Response>;

/**
 * The gateway target map for a forward: prefer the watcher's in-memory
 * snapshot so gateway requests never read disk; the direct read covers only
 * the window before the watcher installs.
 */
const readForwardTargets = (): Map<string, GatewayEntryTarget> => {
  const watched = getWatchedLockfileSnapshot();
  return watched
    ? gatewayTargetsFromLockfile(watched)
    : readGatewayTargets(resolveLockfilePaths(process.env));
};

export const forwardGatewayRequest = async (
  request: Request,
  fetcher: GatewayForwardFetcher,
): Promise<Response | null> => {
  const plan = await authorizeGatewayForwardPlan(
    planGatewayForward(request, readForwardTargets),
    getPairedGuardianAccessToken,
  );
  return executeGatewayForwardPlan(plan, request, fetcher);
};

/**
 * Turn a gateway forward plan into its effect: `null` on `pass` so the caller
 * serves the request as a static asset, otherwise the plan's rejection or a
 * single fetch whose streaming `Response` is returned verbatim, preserving
 * SSE and chunked transfers (Electron's `stream: true` scheme privilege).
 * The plan owns the allowlist and header decisions.
 *
 * Remote hops ride a tunnel that can drop mid-session, so their transport
 * failures become the structured proxy 502 (with one in-proxy retry for
 * transient GET/HEAD failures) instead of a rejected promise the renderer
 * would render as a raw `net::ERR_*` string. No overall response timeout is
 * applied: SSE streams over this forward are long-lived.
 */
export function executeGatewayForwardPlan(
  plan: GatewayForwardPlan,
  request: Pick<Request, "body">,
  fetcher: GatewayForwardFetcher,
  retryOptions: ForwardFetchRetryOptions = {},
): Promise<Response> | Response | null {
  switch (plan.kind) {
    case "pass":
      return null;
    case "reject":
      return new Response(plan.message, { status: plan.status });
    case "forward": {
      const doFetch = () =>
        fetcher(plan.url, {
          method: plan.method,
          headers: plan.headers,
          body: plan.hasBody ? request.body : undefined,
          // Stream the request body instead of buffering it; required by the
          // fetch spec whenever a `ReadableStream` body is supplied.
          ...(plan.hasBody ? { duplex: "half" as const } : {}),
          redirect: "manual",
        });
      if (!plan.remote) {
        return doFetch();
      }
      return fetchForwardPlanWithRetry(plan, doFetch, {
        retries: 1,
        onError: (err, attempt) => {
          console.error(
            `[gateway-forward] fetch failed (attempt ${attempt + 1}) for ${plan.method} ${plan.url}:`,
            err,
          );
        },
        ...retryOptions,
      });
    }
  }
}
