import type { Server } from "bun";

import {
  getAuthRateLimiter,
  type AuthRateLimiter,
} from "../auth-rate-limiter.js";
import { isWebsocketUpgradeRequest } from "./utils.js";
import { ROUTES } from "./routes/index.js";
import type { RouteDefinition } from "./routes/types.js";
import {
  createAuthMiddleware,
  wrapWithAuthFailureTracking,
} from "./middleware/auth.js";

export type GetClientIp = () => string;

/** Params extracted from a regex path match (capture groups). */
export type RouteParams = string[];

/** Every route, expanded into the definitions the matcher consumes. */
const table: RouteDefinition[] = ROUTES.flatMap(expandRoute);

/**
 * Match the request against the route table and run the matching route's
 * handler behind its `auth` strategy. Returns null when no route matches
 * (the caller owns the 404), and resolves undefined only after a WebSocket
 * upgrade has succeeded — coalesced to an inert 101 for the caller.
 */
export async function dispatchRoute(
  req: Request,
  url: URL,
  getClientIp: GetClientIp,
  server: Server<unknown>,
): Promise<Response | null> {
  const matched = await dispatchAt(
    table,
    getAuthRateLimiter(),
    req,
    withoutVersionPrefix(url.pathname),
    getClientIp,
    server,
  );
  return matched === undefined ? INERT_UPGRADE_FALLBACK : matched;
}

/**
 * Test-harness entry: the same engine over a custom table and limiter.
 * Production always goes through dispatchRoute.
 */
export function dispatchForTest(
  routes: ReadonlyArray<RouteDefinition>,
  authRateLimiter: AuthRateLimiter,
): (
  req: Request,
  url: URL,
  getClientIp: GetClientIp,
  server: Server<unknown>,
) => Promise<Response | null> {
  const expanded = routes.flatMap(expandRoute);
  return async (req, url, getClientIp, server) => {
    const matched = await dispatchAt(
      expanded,
      authRateLimiter,
      req,
      withoutVersionPrefix(url.pathname),
      getClientIp,
      server,
    );
    return matched === undefined ? INERT_UPGRADE_FALLBACK : matched;
  };
}

async function dispatchAt(
  table: ReadonlyArray<RouteDefinition>,
  authRateLimiter: AuthRateLimiter,
  req: Request,
  pathname: string,
  getClientIp: GetClientIp,
  server: Server<unknown>,
): Promise<Response | null | undefined> {
  for (const route of table) {
    const matchResult = matchRoute(route, pathname, req.method);
    if (!matchResult) continue;
    if (route.upgradesOnly && !isWebsocketUpgradeRequest(req)) continue;

    // Precondition guard (e.g. "is integration configured?")
    if (route.precondition) {
      const preconditionResponse = route.precondition();
      if (preconditionResponse) return preconditionResponse;
    }

    const auth = route.auth ?? "none";

    switch (auth) {
      case "none":
      case "custom":
        return route.handler(req, matchResult.params, getClientIp, server);

      case "edge": {
        const { requireEdgeAuth } = createAuthMiddleware(
          authRateLimiter,
          getClientIp,
        );
        const authError = await requireEdgeAuth(req);
        if (authError) return authError;
        return route.handler(req, matchResult.params, getClientIp, server);
      }

      case "edge-scoped": {
        const { requireEdgeAuthWithScope } = createAuthMiddleware(
          authRateLimiter,
          getClientIp,
        );
        const authError = await requireEdgeAuthWithScope(req, route.scope!);
        if (authError) return authError;
        return route.handler(req, matchResult.params, getClientIp, server);
      }

      case "edge-guardian": {
        const { requireEdgeGuardianAuth } = createAuthMiddleware(
          authRateLimiter,
          getClientIp,
        );
        const authError = await requireEdgeGuardianAuth(req);
        if (authError) return authError;
        return route.handler(req, matchResult.params, getClientIp, server);
      }

      case "track-failures": {
        return wrapWithAuthFailureTracking(
          (r) => route.handler(r, matchResult.params, getClientIp, server),
          authRateLimiter,
          getClientIp,
          route.trackFailureStatuses,
        )(req);
      }
    }
  }

  return null;
}

export function withoutVersionPrefix(pathname: string): string {
  const stripped = pathname.replace(/^\/v1(?=\/|$)/, "");
  return stripped === "" ? "/" : stripped;
}

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
 * Expand one route declaration into the definitions the matcher consumes:
 * the flat route, its dispatch-only method aliases, and — when `scoped` —
 * the assistant-scoped mirror whose first capture (the assistant id) is
 * discarded before the handler sees the params. Same `RouteDefinition` type
 * in and out; the expansion only unfolds variants — template compilation
 * happens at dispatch.
 */
export function expandRoute(route: RouteDefinition): RouteDefinition[] {
  const expanded: RouteDefinition[] = [route];
  for (const alias of route.aliases ?? []) {
    expanded.push({ ...route, method: alias });
  }
  if (route.scoped) {
    if (typeof route.path !== "string") {
      throw new Error(
        `Scoped route mirrors require a template path: ${route.path}`,
      );
    }
    const scopedPath = `/assistants/{assistant_id}${route.path}`;
    for (const variant of [...expanded]) {
      expanded.push({
        ...variant,
        path: scopedPath,
        handler: (req, params, getClientIp, server) =>
          variant.handler(req, params.slice(1), getClientIp, server),
      });
    }
  }
  return expanded;
}

interface MatchResult {
  params: RouteParams;
}

/**
 * Templates already compiled for dispatch, keyed by the declared spelling.
 * The declaration stays a string; the router owns the one derived regex per
 * template, compiled once on first match — no second field on the route.
 */
const compiledPatterns = new Map<string, RegExp>();

function dispatchPattern(route: RouteDefinition): RegExp | null {
  if (typeof route.path !== "string" || !route.path.includes("{")) return null;
  let pattern = compiledPatterns.get(route.path);
  if (!pattern) {
    pattern = compilePath(route.path);
    compiledPatterns.set(route.path, pattern);
  }
  return pattern;
}

function matchRoute(
  route: RouteDefinition,
  pathname: string,
  method: string,
): MatchResult | null {
  // Check method first (cheapest check). An omitted method serves any method
  // (webhook receivers).
  if (route.method && route.method.toUpperCase() !== method) return null;

  const pattern = dispatchPattern(route);
  if (pattern) {
    const match = pathname.match(pattern);
    return match ? { params: match.slice(1) } : null;
  }

  if (typeof route.path === "string") {
    // Static path — exact match against the declared spelling, plus the two
    // legacy assistant prefixes some long-lived clients still dial.
    // Normalize trailing slashes so "/v1/foo/" matches "/v1/foo".
    const normalized =
      pathname.length > 1 && pathname.endsWith("/")
        ? pathname.slice(0, -1)
        : pathname;
    if (normalized === route.path) return { params: [] };
    if (normalized === `/v1/assistant${route.path}`) return { params: [] };
    if (normalized === `/assistant${route.path}`) return { params: [] };
    return null;
  }

  // Raw regex path — use the original pathname since regex routes may
  // explicitly include trailing slashes in their patterns.
  const match = pathname.match(route.path);
  if (!match) return null;
  return { params: match.slice(1) };
}

/** Returned when a handler resolves to undefined (a completed WS upgrade). */
const INERT_UPGRADE_FALLBACK = new Response(null, { status: 101 });
