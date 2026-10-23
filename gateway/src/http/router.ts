import type { Server } from "bun";

import type { Scope } from "../auth/types.js";
import type { AuthRateLimiter } from "../auth-rate-limiter.js";
import {
  createAuthMiddleware,
  wrapWithAuthFailureTracking,
} from "./middleware/auth.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type GetClientIp = () => string;
export type GetRawPeerIp = () => string;

/**
 * Auth strategy for a route:
 * - "none"         — no auth check, handler called directly
 * - "edge"         — edge JWT token required (aud=cadet-gateway)
 * - "edge-scoped"  — edge JWT + scope check (requires `scope` field)
 * - "edge-guardian" — caller must be the bound cadet guardian. In the default
 *                      path, edge JWT is validated and the caller's actor
 *                      principal must match the guardian's principal id.
 *                      When DISABLE_HTTP_AUTH=true (cloud-managed), the
 *                      caller is asserted via X-Cadet-User-Id forwarded by
 *                      vembda, cross-referenced with the bound platform
 *                      user id.
 * - "track-failures" — no gateway-level auth, but downstream 401s are
 *                      recorded against the rate limiter
 * - "custom"       — the handler manages auth internally
 */
type AuthStrategy =
  | "none"
  | "edge"
  | "edge-scoped"
  | "edge-guardian"
  | "track-failures"
  | "custom";

/** Params extracted from a regex path match (capture groups). */
export type RouteParams = string[];

export interface RouteDefinition {
  /** Static path string or regex pattern. Regex capture groups become `params`. */
  path: string | RegExp;
  /** HTTP method to match. Omit to match any method. */
  method?: string;
  /** Auth strategy (default: "none"). */
  auth?: AuthStrategy;
  /** Required scope when auth is "edge-scoped". */
  scope?: Scope;
  /**
   * Status codes that count as auth failures for rate limiting.
   * Only used with "track-failures" auth. Defaults to [401].
   */
  trackFailureStatuses?: readonly number[];
  /**
   * Optional precondition check. Return a Response to short-circuit,
   * or null to continue to the handler.
   */
  precondition?: () => Response | null;
  /** Route handler. Params are populated from regex capture groups. */
  handler: (
    req: Request,
    params: RouteParams,
    getClientIp: GetClientIp,
    getRawPeerIp: GetRawPeerIp,
  ) => Promise<Response> | Response;
}

export interface RouterDeps {
  authRateLimiter: AuthRateLimiter;
  /**
   * When true, a trusted reverse proxy is declared in front of the gateway, so
   * the loopback auth fallback judges callers by the real client IP from
   * X-Forwarded-For instead of the raw socket peer. Defaults to false.
   */
  trustProxy?: boolean;
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

/**
 * Create a router function from a declarative route table.
 *
 * The returned function matches the first route whose path and method match,
 * applies auth middleware per the route's `auth` strategy, and calls the
 * handler. Returns null if no route matches.
 */
export function createRouter(
  routes: RouteDefinition[],
  deps: RouterDeps,
): (
  req: Request,
  url: URL,
  getClientIp: GetClientIp,
  server?: Server<unknown>,
) => Promise<Response | null> {
  const { authRateLimiter, trustProxy = false } = deps;

  return async (
    req: Request,
    url: URL,
    getClientIp: GetClientIp,
    server?: Server<unknown>,
  ) => {
    const getRawPeerIp: GetRawPeerIp = () =>
      server?.requestIP(req)?.address ?? "unknown";

    const dispatchAt = async (pathname: string): Promise<Response | null> => {
      for (const route of routes) {
        const matchResult = matchRoute(route, pathname, req.method);
        if (!matchResult) continue;

        // Precondition guard (e.g. "is integration configured?")
        if (route.precondition) {
          const preconditionResponse = route.precondition();
          if (preconditionResponse) return preconditionResponse;
        }

        const auth = route.auth ?? "none";

        switch (auth) {
          case "none":
          case "custom":
            return route.handler(
              req,
              matchResult.params,
              getClientIp,
              getRawPeerIp,
            );

          case "edge": {
            const { requireEdgeAuth } = createAuthMiddleware(
              authRateLimiter,
              getClientIp,
              trustProxy,
            );
            const authError = await requireEdgeAuth(req, server);
            if (authError) return authError;
            return route.handler(
              req,
              matchResult.params,
              getClientIp,
              getRawPeerIp,
            );
          }

          case "edge-scoped": {
            const { requireEdgeAuthWithScope } = createAuthMiddleware(
              authRateLimiter,
              getClientIp,
              trustProxy,
            );
            const authError = await requireEdgeAuthWithScope(
              req,
              route.scope!,
              server,
            );
            if (authError) return authError;
            return route.handler(
              req,
              matchResult.params,
              getClientIp,
              getRawPeerIp,
            );
          }

          case "edge-guardian": {
            const { requireEdgeGuardianAuth } = createAuthMiddleware(
              authRateLimiter,
              getClientIp,
              trustProxy,
            );
            const authError = await requireEdgeGuardianAuth(req, server);
            if (authError) return authError;
            return route.handler(
              req,
              matchResult.params,
              getClientIp,
              getRawPeerIp,
            );
          }

          case "track-failures": {
            return wrapWithAuthFailureTracking(
              (r) =>
                route.handler(r, matchResult.params, getClientIp, getRawPeerIp),
              authRateLimiter,
              getClientIp,
              route.trackFailureStatuses,
            )(req);
          }
        }
      }

      return null;
    };

    // The /v1 version prefix is optional (P7 of the one-url plan): route
    // definitions read unversioned and the dispatcher strips one optional
    // /v1 from the dial, so both spellings resolve to the same routes. The
    // handler's `req` keeps the dial exactly as sent. The unversioned WS
    // upgrade paths (stt, watch, live-voice, desktop) still arrive only in
    // the /v1 spelling — their pre-router checks run before this router and
    // move with the caller migration.
    return dispatchAt(withoutVersionPrefix(url.pathname));
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Strip one optional leading `/v1` version segment (P7 of the one-url plan:
 * the version digit is leaving the URL path — match definitions read the
 * unversioned shape, and the dispatcher strips the prefix from
 * not-yet-migrated `/v1`-spelled dials so both spellings stay live).
 */
export function withoutVersionPrefix(pathname: string): string {
  const stripped = pathname.replace(/^\/v1(?=\/|$)/, "");
  return stripped === "" ? "/" : stripped;
}

interface MatchResult {
  params: RouteParams;
}

function matchRoute(
  route: RouteDefinition,
  pathname: string,
  method: string,
): MatchResult | null {
  // Check method first (cheapest check)
  if (route.method && route.method !== method) return null;

  if (typeof route.path === "string") {
    // Normalize trailing slashes so "/v1/foo/" matches "/v1/foo"
    const normalized =
      pathname.length > 1 && pathname.endsWith("/")
        ? pathname.slice(0, -1)
        : pathname;
    if (normalized !== route.path) return null;
    return { params: [] };
  }

  // Regex path — use original pathname since regex routes may
  // explicitly include trailing slashes in their patterns.
  const match = pathname.match(route.path);
  if (!match) return null;
  return { params: match.slice(1) };
}
