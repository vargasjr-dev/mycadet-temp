import {
  authorizePairedForwardHeaders,
  gatewayTargetsFromLockfile,
  loopbackGatewayBearer,
  readGatewayTargets,
  resolveGatewayProxyTarget,
  resolveLockfilePath,
  sanitizePairedForwardHeaders,
  type GatewayEntryTarget,
  type GuardianTokenLease,
  type PairedGuardianTokenProvider,
} from "@mycadet/local-mode";

import {
  fetchForwardPlanWithRetry,
  type ForwardFetchRetryOptions,
} from "./cloud-forward";
import { getWatchedLockfileSnapshot } from "./lockfile-watcher";
import {
  getLocalGuardianAccessToken,
  getPairedGuardianAccessToken,
} from "./local-mode";

/**
 * Planning and execution for the gateway data-plane proxy: the same-origin
 * id-keyed forward. The scoped SDK surface (`/v1/assistants/{assistantId}/*`)
 * forwards the scoped path verbatim (contact-family flattened). The lockfile
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
 * own loopback origin (the gateway gates loopback web origins on its
 * browser-reachable routes). The executor owns the `Authorization` header: it
 * overwrites whatever the renderer sent with the bearer it mints from the
 * on-disk guardian token, so nothing token-shaped ever crosses into the
 * renderer.
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
  return watched ? gatewayTargetsFromLockfile(watched) : readGatewayTargets();
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
      if (!plan.remote) {
        return executeLoopbackForward(plan, request, fetcher);
      }
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

/**
 * Execute a loopback forward with host-side bearer custody: the executor
 * overwrites whatever the renderer sent with the bearer the main process
 * mints from the on-disk guardian token — except on the mint route itself,
 * whose bearer contract is the guardian token. A gateway 401 on a bodyless
 * request forces one re-mint and one retry, so a revoked bearer heals on the
 * next request instead of 401ing until the cache expires; bodied requests
 * cannot replay (the request stream is already consumed), so their 401 flows
 * back to the caller. When the mint fails the request forwards without a
 * bearer and the gateway's own response surfaces the truth.
 */
async function executeLoopbackForward(
  plan: Extract<GatewayForwardPlan, { kind: "forward"; remote: false }>,
  request: Pick<Request, "body">,
  fetcher: GatewayForwardFetcher,
): Promise<Response> {
  const lease: GuardianTokenLease = () =>
    getLocalGuardianAccessToken(plan.assistantId);
  // The mint dials the same network seam as the forward, so a recorded or
  // stubbed fetcher sees both hops.
  const mintFetcher = (input: RequestInfo | URL, init?: RequestInit) =>
    fetcher(String(input), init ?? {});
  const injectable = new URL(plan.url).pathname !== "/auth/token";
  const bearer = injectable
    ? await loopbackGatewayBearer(plan.target.port, lease, {
        fetcher: mintFetcher,
      })
    : null;
  if (injectable && bearer) {
    plan.headers.set("authorization", `Bearer ${bearer}`);
  } else {
    plan.headers.delete("authorization");
  }
  const doFetch = () =>
    fetcher(plan.url, {
      method: plan.method,
      headers: plan.headers,
      body: plan.hasBody ? request.body : undefined,
      ...(plan.hasBody ? { duplex: "half" as const } : {}),
      redirect: "manual",
    });
  const response = await doFetch();
  if (response.status !== 401 || !bearer || plan.hasBody) {
    return response;
  }
  const fresh = await loopbackGatewayBearer(plan.target.port, lease, {
    forceMint: true,
    fetcher: mintFetcher,
  });
  if (!fresh || fresh === bearer) {
    return response;
  }
  plan.headers.set("authorization", `Bearer ${fresh}`);
  return doFetch();
}
