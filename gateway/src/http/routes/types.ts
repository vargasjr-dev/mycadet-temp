import type { z } from "zod";

import type { Scope } from "../../auth/types.js";
import type { GetClientIp, GetRawPeerIp, RouteParams } from "../router.js";

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
export type AuthStrategy =
  | "none"
  | "edge"
  | "edge-scoped"
  | "edge-guardian"
  | "track-failures"
  | "custom";

/** Handler signature the router calls with params from the path match. */
export type RouteHandler = (
  req: Request,
  params: RouteParams,
  getClientIp: GetClientIp,
  getRawPeerIp: GetRawPeerIp,
) => Promise<Response> | Response;

/**
 * The single declaration of a gateway HTTP route — both the runtime dispatch
 * table and the OpenAPI generation script consume the same `ROUTES` arrays.
 *
 * The spec fields (operationId, schemas, parameter docs) feed the generated
 * spec; the dispatch fields (auth, scope, handler) feed `createRouter`.
 * Routes that only exist at runtime (webhooks, proxies, websockets) stay
 * off the spec by omitting `operationId` — the generator projects only
 * fully-documented entries.
 */
export interface GatewayRouteDefinition {
  /**
   * Unversioned path — usually a `{param}` template, e.g.
   * `/channel-admission-policy/{channel_type}`, which the router compiles
   * to a regex (trailing-slash tolerant) and the generator emits verbatim.
   * A raw RegExp is allowed for the rare dispatch pattern a template cannot
   * express (e.g. the contacts DELETE catch-all's negative lookahead); when
   * such a route is published in the spec, its capture groups must be NAMED
   * so the generator can map them to `{param}` templates.
   */
  path: string | RegExp;
  method?: "get" | "post" | "put" | "patch" | "delete";
  /** Required for spec publication. Omit on runtime-only routes. */
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  responseBody?: z.ZodTypeAny;
  requestBody?: z.ZodTypeAny;
  pathParameters?: Array<{ name: string; description?: string }>;
  /** Optional string query parameters (all documented as non-required). */
  queryParameters?: Array<{ name: string; description?: string }>;
  /**
   * Success status code documented in the spec. Defaults to "200".
   * Use "204" for empty-body responses (responseBody must be omitted).
   */
  responseStatus?: "200" | "201" | "204";

  // ── Dispatch-only fields ──
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
   * Extra dispatch-only methods served by the same handler on the same path
   * (legacy client compatibility). Never published in the spec.
   */
  aliases?: Array<"post" | "put" | "patch" | "delete">;
  /**
   * Also register the assistant-scoped mirror `/assistants/{assistant_id}`
   * + path. The assistant id is matched and discarded before the handler's
   * params, so handlers see the same params as the flat route. Never
   * published separately in the spec.
   */
  scoped?: boolean;
  /**
   * Optional precondition check. Return a Response to short-circuit,
   * or null to continue to the handler.
   */
  precondition?: () => Response | null;
  /**
   * The route's handler. Built once at module scope (typically
   * `handler: createXHandler(deps)` over injected module state) — importing
   * a ROUTES module stays free of side effects because the factories only
   * build closures.
   */
  handler: RouteHandler;
}
