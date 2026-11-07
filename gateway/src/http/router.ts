import type { Server } from "bun";

import type { AuthStrategy, GatewayRouteDefinition, RouteHandler } from "./routes/types.js";
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


/** Params extracted from a regex path match (capture groups). */
export type RouteParams = string[];

export interface RouteDefinition {
  /** Static path string or regex pattern. Regex capture groups become `params`. */
  path: string | RegExp;
  /**
   * Canonical spec path for raw-regex routes the OpenAPI generator publishes
   * under a `{param}` template (e.g. the contacts DELETE catch-all's
   * lookahead, which a template cannot express).
   */
  specPath?: string;
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
  handler: RouteHandler;
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
  routes: ReadonlyArray<GatewayRouteDefinition | RouteDefinition>,
  deps: RouterDeps,
): (
  req: Request,
  url: URL,
  getClientIp: GetClientIp,
  server?: Server<unknown>,
) => Promise<Response | null> {
  const { authRateLimiter } = deps;
  const table: RouteDefinition[] = routes.flatMap(expandRoute);

  return async (
    req: Request,
    url: URL,
    getClientIp: GetClientIp,
    server?: Server<unknown>,
  ) => {
    const getRawPeerIp: GetRawPeerIp = () =>
      server?.requestIP(req)?.address ?? "unknown";

    const dispatchAt = async (pathname: string): Promise<Response | null> => {
      for (const route of table) {
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
            );
            const authError = await requireEdgeAuth(req);
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
            );
            const authError = await requireEdgeAuthWithScope(req, route.scope!);
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
            );
            const authError = await requireEdgeGuardianAuth(req);
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


// ---------------------------------------------------------------------------
// Fused-route expansion
// ---------------------------------------------------------------------------

/**
 * Compile a `{param}` path template into the dispatch regex: single-segment
 * captures, trailing slash tolerated. Mirrors the hand-written regexes this
 * replaces (`/^\/x\/([^/]+)\/?$/`).
 */
export function compilePath(template: string): RegExp {
  if (!template.startsWith("/")) {
    throw new Error(`Route template must start with "/": ${template}`);
  }
  const pattern = template
    .split("/")
    .map((segment) => {
      if (!segment.startsWith("{") || !segment.endsWith("}")) {
        return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      }
      const name = segment.slice(1, -1);
      if (!/^[A-Za-z0-9_]+$/.test(name)) {
        throw new Error(`Invalid route parameter: {${name}}`);
      }
      return "([^/]+)";
    })
    .join("/");
  return new RegExp(`^${pattern}/?$`);
}

/**
 * Expand one fused route declaration into the internal definitions the
 * matcher consumes: the flat route, its dispatch-only method aliases, and —
 * when `scoped` — the assistant-scoped mirror whose first capture (the
 * assistant id) is discarded before the handler sees the params.
 */
export function expandRoute(
  route: GatewayRouteDefinition | RouteDefinition,
): RouteDefinition[] {
  if (!isFused(route)) return [route as RouteDefinition];

  const handler = route.createHandler();
  const flat: RouteDefinition = {
    path: typeof route.path === "string" ? compilePath(route.path) : route.path,
    method: route.method.toUpperCase(),
    auth: route.auth,
    scope: route.scope,
    trackFailureStatuses: route.trackFailureStatuses,
    precondition: route.precondition,
    handler: (req, params, getClientIp, getRawPeerIp) =>
      handler(req, params, getClientIp, getRawPeerIp),
  };
  const expanded: RouteDefinition[] = [flat];
  for (const alias of route.aliases ?? []) {
    expanded.push({ ...flat, method: alias.toUpperCase() });
  }
  if (route.scoped) {
    expanded.push({
      ...flat,
      path: compilePath(`/assistants/{assistant_id}${route.path}`),
      handler: (req, params, getClientIp, getRawPeerIp) =>
        handler(req, params.slice(1), getClientIp, getRawPeerIp),
    });
  }
  return expanded;
}

function isFused(route: GatewayRouteDefinition | RouteDefinition): route is GatewayRouteDefinition {
  return "createHandler" in route;
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
    if (normalized === route.path) return { params: [] };
    if (normalized === `/v1/assistant${route.path}`) return { params: [] };
    if (normalized === `/assistant${route.path}`) return { params: [] };
    return null;
  }

  // Regex path — use original pathname since regex routes may
  // explicitly include trailing slashes in their patterns.
  const match = pathname.match(route.path);
  if (!match) return null;
  return { params: match.slice(1) };
}
