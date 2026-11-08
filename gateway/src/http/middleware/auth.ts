import {
  admitActorToken,
  type AdmittedActorTokenRecord,
} from "../../auth/actor-token-revocation.js";
import { findCadetGuardian } from "../../auth/guardian-bootstrap.js";
import {
  isNarrowScopeProfile,
  resolveScopeProfile,
} from "../../auth/scopes.js";
import { parseSub } from "../../auth/subject.js";
import { validateEdgeToken } from "../../auth/token-exchange.js";
import { getRemoteWebAccessCookie } from "../browser-auth-cookies.js";
import type { Scope, TokenClaims } from "../../auth/types.js";
import type { AuthRateLimiter } from "../../auth-rate-limiter.js";
import { getIsCloud } from "../../cloud-url.js";
import { getLogger } from "../../logger.js";
import { readStoredCloudUserId } from "../../cloud-identity.js";

const log = getLogger("auth");

type GetClientIp = () => string;

// ---------------------------------------------------------------------------
// Clout auth bypass — DISABLE_HTTP_AUTH + IS_CLOUD
// ---------------------------------------------------------------------------
//
// Both flags must be set together to disable JWT validation.

/** True when DISABLE_HTTP_AUTH=true. */
export function isHttpAuthDisabled(): boolean {
  return process.env.DISABLE_HTTP_AUTH?.trim().toLowerCase() === "true";
}

/**
 * True when the cloud-managed auth bypass is in effect — both flags set.
 * Either alone leaves JWT validation in place.
 */
export function isCloudAuthBypassActive(): boolean {
  return isHttpAuthDisabled() && getIsCloud();
}

/**
 * Log auth bypass state at gateway startup. Call once after the logger is
 * initialized.
 */
export function logAuthBypassState(): void {
  if (!isHttpAuthDisabled()) {
    return;
  }
  if (getIsCloud()) {
    log.info(
      "DISABLE_HTTP_AUTH + IS_CLOUD both set: JWT validation bypassed; " +
        "X-Cadet-User-Id is cross-checked against the bound platform user id",
    );
  } else {
    log.warn(
      "DISABLE_HTTP_AUTH is set but IS_CLOUD is NOT — bypass is INACTIVE. " +
        "JWT validation runs as normal. Set IS_CLOUD=true to opt into the " +
        "cloud-managed auth model.",
    );
  }
}

/**
 * The actor-token row the auth layer already loaded by the request bearer's
 * hash while admitting it (see admitActorToken), keyed by request so routes
 * can reuse the row instead of re-querying the same token hash.
 */
const admittedActorTokenRecords = new WeakMap<
  Request,
  AdmittedActorTokenRecord
>();

/** The admitted actor-token row for this request, when edge auth loaded one. */
export function admittedActorTokenRecord(
  req: Request,
): AdmittedActorTokenRecord | undefined {
  return admittedActorTokenRecords.get(req);
}

/**
 * Build edge-auth guard functions that share a rate limiter and IP resolver.
 *
 *   - `requireEdgeAuth` — validates a JWT bearer token (aud=cadet-gateway)
 *     OR (when bypass is active) cross-checks X-Cadet-User-Id against the
 *     bound platform user id.
 *   - `requireEdgeAuthWithScope` — same, plus a scope-profile check on the
 *     decoded JWT. Under the cloud bypass, scope is enforced upstream by
 *     vembda; the gateway only verifies the cross-checked user id.
 *   - `requireEdgeGuardianAuth` — same pattern, additionally requires the
 *     authenticated principal to match the bound guardian.
 *
 * All three refuse a single-route grant (see `isSingleRouteGrant`) outright:
 * such a grant is handed to code outside this install's trust boundary,
 * which usually runs on the loopback host itself.
 */
export function createAuthMiddleware(
  authRateLimiter: AuthRateLimiter,
  getClientIp: GetClientIp,
) {
  /**
   * Cross-check `X-Cadet-User-Id` against the bound platform user id.
   * Used by all three guards under the cloud-managed bypass. Returns
   * null on success, or a 4xx/5xx Response.
   */
  async function requireCloudUserHeader(
    req: Request,
  ): Promise<Response | null> {
    const headerUserId = req.headers.get("x-cadet-user-id");
    if (!headerUserId) {
      log.warn(
        { path: new URL(req.url).pathname },
        "Edge auth rejected: missing X-Cadet-User-Id (platform bypass active)",
      );
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    let storedUserId: string | undefined;
    let unreachable = false;
    try {
      const result = await readStoredCloudUserId();
      storedUserId = result.userId;
      unreachable = result.unreachable;
    } catch (err) {
      log.error(
        { path: new URL(req.url).pathname, err },
        "Edge auth: platform user id lookup failed",
      );
      return Response.json({ error: "Service Unavailable" }, { status: 503 });
    }
    if (unreachable) {
      log.warn(
        { path: new URL(req.url).pathname },
        "Edge auth: platform identity prerequisites unreachable",
      );
      return Response.json({ error: "Service Unavailable" }, { status: 503 });
    }
    if (!storedUserId) {
      log.warn(
        { path: new URL(req.url).pathname },
        "Edge auth rejected: no platform user id bound on this assistant",
      );
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
    if (storedUserId !== headerUserId) {
      log.warn(
        { path: new URL(req.url).pathname },
        "Edge auth rejected: X-Cadet-User-Id does not match bound platform user id",
      );
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
    return null;
  }

  /**
   * Validate a JWT bearer token (aud=cadet-gateway) for client-facing routes.
   * Loopback peers (127.0.0.0/8, ::1) fall back when auth is missing,
   * malformed, or invalid.
   */
  async function requireEdgeAuth(req: Request): Promise<Response | null> {
    if (isCloudAuthBypassActive()) {
      return requireCloudUserHeader(req);
    }
    const hasAuthHeader = hasAuthorizationHeader(req);
    const token = extractBearerToken(req);
    if (token) {
      return validateEdgeBearer(req, token);
    }
    if (hasAuthHeader) {
      return rejectMalformedAuthorization(req, "Edge auth");
    }
    return rejectMissingAuthorization(req, "Edge auth");
  }

  /**
   * Validate a JWT bearer token and check that its scope profile includes the
   * required scope. Loopback peers fall back when auth is missing, malformed,
   * invalid, or under-scoped. Under the cloud bypass, scope is enforced
   * upstream by vembda — the gateway only confirms the user id.
   */
  async function requireEdgeAuthWithScope(
    req: Request,
    scope: Scope,
  ): Promise<Response | null> {
    if (isCloudAuthBypassActive()) {
      return requireCloudUserHeader(req);
    }
    const hasAuthHeader = hasAuthorizationHeader(req);
    const token = extractBearerToken(req);
    if (token) {
      return validateScopedEdgeBearer(req, token, scope);
    }
    if (hasAuthHeader) {
      return rejectMalformedAuthorization(req, "Scoped edge auth", { scope });
    }
    return rejectMissingAuthorization(req, "Scoped edge auth", { scope });
  }

  /**
   * Assert that the caller is the assistant's bound cadet guardian.
   *
   * Two auth modes:
   *
   *   1. Platform-managed (DISABLE_HTTP_AUTH + IS_CLOUD): caller's identity
   *      is asserted via X-Cadet-User-Id cross-checked against the bound
   *      platform user id.
   *   2. Default: validate the edge JWT, require an actor principal, assert it
   *      matches the bound guardian's principal id.
   *
   * Loopback peers fall back when guardian auth is missing, malformed, invalid,
   * or not authorized.
   */
  async function requireEdgeGuardianAuth(
    req: Request,
  ): Promise<Response | null> {
    if (isCloudAuthBypassActive()) {
      return requireCloudUserHeader(req);
    }
    return requireEdgeGuardianAuthByActorPrincipal(req);
  }

  function validateEdgeBearer(req: Request, token: string): Response | null {
    const result = validateEdgeToken(token);
    if (!result.ok) {
      authRateLimiter.recordFailure(getClientIp());
      log.warn(
        { path: new URL(req.url).pathname, reason: result.reason },
        "Edge auth rejected: token validation failed",
      );
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const contained = rejectSingleRouteGrant(req, result.claims, "Edge auth");
    if (contained) return contained;
    return rejectIfActorTokenRevoked(req, token, result.claims);
  }

  function validateScopedEdgeBearer(
    req: Request,
    token: string,
    scope: Scope,
  ): Response | null {
    const result = validateEdgeToken(token);
    if (!result.ok) {
      authRateLimiter.recordFailure(getClientIp());
      log.warn(
        { path: new URL(req.url).pathname, scope, reason: result.reason },
        "Scoped edge auth rejected: token validation failed",
      );
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const contained = rejectSingleRouteGrant(
      req,
      result.claims,
      "Scoped edge auth",
      { scope },
    );
    if (contained) return contained;
    const revoked = rejectIfActorTokenRevoked(req, token, result.claims);
    if (revoked) return revoked;
    const scopes = resolveScopeProfile(result.claims.scope_profile);
    if (!scopes.has(scope)) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
    return null;
  }

  function rejectMissingAuthorization(
    req: Request,
    label: string,
    extra?: Record<string, unknown>,
  ): Response | null {
    authRateLimiter.recordFailure(getClientIp());
    log.warn(
      { path: new URL(req.url).pathname, ...extra },
      `${label} rejected: missing Authorization header`,
    );
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  function rejectMalformedAuthorization(
    req: Request,
    label: string,
    extra?: Record<string, unknown>,
  ): Response | null {
    authRateLimiter.recordFailure(getClientIp());
    log.warn(
      { path: new URL(req.url).pathname, ...extra },
      `${label} rejected: malformed Authorization header`,
    );
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  /**
   * Refuse a grant minted for one route. Edge auth speaks for its caller on
   * every route it guards, which such a grant may not do, so the refusal is
   * unconditional: the loopback fallback would hand back what it withholds.
   */
  function rejectSingleRouteGrant(
    req: Request,
    claims: TokenClaims,
    label: string,
    extra?: Record<string, unknown>,
  ): Response | null {
    if (!isSingleRouteGrant(claims)) return null;
    authRateLimiter.recordFailure(getClientIp());
    log.warn(
      {
        path: new URL(req.url).pathname,
        scopeProfile: claims.scope_profile,
        ...extra,
      },
      `${label} rejected: grant is scoped to a single route`,
    );
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  /**
   * Run a validated edge token through actor-token admission: revoked records
   * get a 401, everything else continues (null) with the presenting device's
   * last-used activity stamped. Fail-open for non-actor and unrecorded tokens
   * (see admitActorToken).
   *
   * Admission runs here, before the scope and guardian-match checks that
   * callers apply afterwards, so "last used" means "presented a valid,
   * unrevoked credential" rather than "made a request we served". That is
   * deliberate: a device refused for insufficient scope is still demonstrably
   * active, and a guardian-mismatched device never appears in /v1/devices
   * anyway (it scopes to the local guardian principal).
   */
  function rejectIfActorTokenRevoked(
    req: Request,
    token: string,
    claims: TokenClaims,
  ): Response | null {
    const admission = admitActorToken(token, claims);
    if (admission.record) {
      admittedActorTokenRecords.set(req, admission.record);
    }
    if (!admission.admitted) {
      authRateLimiter.recordFailure(getClientIp());
      log.warn(
        { path: new URL(req.url).pathname },
        "Edge auth rejected: actor token revoked",
      );
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    return null;
  }

  /**
   * Default path — validate JWT, require actor principal, assert it matches
   * the bound cadet guardian.
   */
  async function requireEdgeGuardianAuthByActorPrincipal(
    req: Request,
  ): Promise<Response | null> {
    const token = extractBearerToken(req);
    if (!token) {
      authRateLimiter.recordFailure(getClientIp());
      log.warn(
        { path: new URL(req.url).pathname },
        "Guardian edge auth rejected: missing or malformed Authorization header",
      );
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const result = validateEdgeToken(token);
    if (!result.ok) {
      authRateLimiter.recordFailure(getClientIp());
      log.warn(
        { path: new URL(req.url).pathname, reason: result.reason },
        "Guardian edge auth rejected: token validation failed",
      );
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const contained = rejectSingleRouteGrant(
      req,
      result.claims,
      "Guardian edge auth",
    );
    if (contained) return contained;
    const revoked = rejectIfActorTokenRevoked(req, token, result.claims);
    if (revoked) return revoked;
    const parsed = parseSub(result.claims.sub);
    if (
      !parsed.ok ||
      parsed.principalType !== "actor" ||
      !parsed.actorPrincipalId
    ) {
      log.warn(
        { path: new URL(req.url).pathname },
        "Guardian edge auth rejected: caller is not an actor principal",
      );
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
    let guardian: { principalId: string } | null;
    try {
      guardian = await findCadetGuardian();
    } catch (err) {
      log.error(
        { path: new URL(req.url).pathname, err },
        "Guardian edge auth: findCadetGuardian failed",
      );
      return Response.json({ error: "Service Unavailable" }, { status: 503 });
    }
    if (!guardian || guardian.principalId !== parsed.actorPrincipalId) {
      log.warn(
        { path: new URL(req.url).pathname },
        "Guardian edge auth rejected: caller is not the bound guardian",
      );
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
    return null;
  }

  return {
    requireEdgeAuth,
    requireEdgeAuthWithScope,
    requireEdgeGuardianAuth,
  };
}

/**
 * Wrap a handler so that responses with specific status codes automatically
 * record an auth failure. Defaults to tracking 401 responses.
 *
 * Eliminates the repeated `if (res.status === 401) { ... }` boilerplate.
 */
export function wrapWithAuthFailureTracking(
  handler: (req: Request) => Promise<Response> | Response,
  authRateLimiter: AuthRateLimiter,
  getClientIp: GetClientIp,
  failureStatuses: readonly number[] = [401],
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const res = await handler(req);
    if (failureStatuses.includes(res.status)) {
      authRateLimiter.recordFailure(getClientIp());
    }
    return res;
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Conversation component of an OAuth passthrough grant's subject. */
const OAUTH_PROXY_SUBJECT_PREFIX = "oauth-proxy.";

/**
 * True when the claims name a grant minted for a single route rather than an
 * edge credential. A narrow scope profile is the gate, since edge auth speaks
 * for its caller on every route it guards; the subject shape is a second
 * signal, catching a proxy grant that carries some other profile.
 */
function isSingleRouteGrant(claims: TokenClaims): boolean {
  if (isNarrowScopeProfile(claims.scope_profile)) return true;
  const parsed = parseSub(claims.sub);
  return (
    parsed.ok &&
    parsed.principalType === "local" &&
    (parsed.conversationId ?? "").startsWith(OAUTH_PROXY_SUBJECT_PREFIX)
  );
}

/**
 * Extract the raw token from a Bearer Authorization header, falling back to the
 * browser access cookie (`cadet_web_access`); null when neither is present.
 *
 * Shared with the runtime-proxy handlers: a served-gateway browser holds no
 * token in JS (#576 cookie custody), so every consumer-facing auth gate that
 * the browser's requests reach has to accept the cookie where the edge
 * middleware does.
 */
export function extractBearerToken(req: Request): string | null {
  const authHeader = req.headers.get("authorization");
  if (authHeader?.toLowerCase().startsWith("bearer ")) {
    return authHeader.slice(7);
  }
  const cookieToken = getRemoteWebAccessCookie(req);
  return cookieToken || null;
}

export function hasAuthorizationHeader(req: Request): boolean {
  return Boolean(req.headers.get("authorization")?.trim());
}
