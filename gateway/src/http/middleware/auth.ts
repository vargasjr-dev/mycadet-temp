import type { Server } from "bun";

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
import { AuthFallbackLogThrottle } from "../../auth-fallback-log-throttle.js";
import type { AuthRateLimiter } from "../../auth-rate-limiter.js";
import { getIsCloud } from "../../cloud-url.js";
import { getLogger } from "../../logger.js";
import { readStoredCloudUserId } from "../../cloud-user-id.js";
import { isLoopbackPeer } from "../../util/is-loopback-address.js";
import { requestArrivedViaEdgeProxy } from "../edge-forwarded-header.js";

const log = getLogger("auth");

// Suppresses repeat "legacy loopback fallback" warnings: each (guard, path)
// logs at most once per cooldown window so the rollout signal stays visible
// without per-request noise. Process-lifetime — createAuthMiddleware is invoked
// per request, so this state can't live in its closure.
const loopbackFallbackLogThrottle = new AuthFallbackLogThrottle();

type GetClientIp = () => string;

// ---------------------------------------------------------------------------
// Platform-managed auth bypass — DISABLE_HTTP_AUTH + IS_CLOUD
// ---------------------------------------------------------------------------
//
// Both flags must be set together to disable JWT validation. DISABLE_HTTP_AUTH
// alone is insufficient — it closes the accidental misconfig case where the
// flag gets set on a non-cloud deployment (e.g. a leaked dev env var on a
// public host). When the bypass IS active, the cloud vembda sidecar is
// expected to forward `X-Cadet-User-Id`; the gateway cross-checks that
// against the bound platform user id. This means reaching the gateway
// sidecar's port directly (without going through vembda) still requires
// knowing the bound user id. The cloud header alone is not a free-pass.

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
 * All three guards retain a legacy loopback fallback for self-hosted local
 * clients. Each fallback endpoint and failure kind logs once per cooldown
 * window (see `loopbackFallbackLogThrottle`) so callers still missing or
 * failing auth are visible during rollout without per-request log noise. The
 * cloud-managed bypass is checked first, so this fallback only applies in
 * default mode.
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
 * All three refuse a single-route grant (see `isSingleRouteGrant`) outright,
 * with no loopback fallback: such a grant is handed to code outside this
 * install's trust boundary, which usually runs on the loopback host itself.
 */
export function createAuthMiddleware(
  authRateLimiter: AuthRateLimiter,
  getClientIp: GetClientIp,
  trustProxy = false,
) {
  /**
   * Cross-check `X-Cadet-User-Id` against the bound platform user id.
   * Used by all three guards under the cloud-managed bypass. Returns
   * null on success, or a 4xx/5xx Response.
   */
  async function requirePlatformUserHeader(
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
  async function requireEdgeAuth(
    req: Request,
    server?: Server<unknown>,
  ): Promise<Response | null> {
    if (isCloudAuthBypassActive()) {
      return requirePlatformUserHeader(req);
    }
    const hasAuthHeader = hasAuthorizationHeader(req);
    const token = extractBearerToken(req);
    if (token) {
      return validateEdgeBearer(req, token, server);
    }
    if (hasAuthHeader) {
      return rejectMalformedAuthorization(req, "Edge auth", server, "edge");
    }
    return rejectMissingAuthorization(req, "Edge auth", server, "edge");
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
    server?: Server<unknown>,
  ): Promise<Response | null> {
    if (isCloudAuthBypassActive()) {
      return requirePlatformUserHeader(req);
    }
    const hasAuthHeader = hasAuthorizationHeader(req);
    const token = extractBearerToken(req);
    if (token) {
      return validateScopedEdgeBearer(req, token, scope, server);
    }
    if (hasAuthHeader) {
      return rejectMalformedAuthorization(
        req,
        "Scoped edge auth",
        server,
        "edge-scoped",
        { scope },
      );
    }
    return rejectMissingAuthorization(
      req,
      "Scoped edge auth",
      server,
      "edge-scoped",
      { scope },
    );
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
    server?: Server<unknown>,
  ): Promise<Response | null> {
    if (isCloudAuthBypassActive()) {
      return requirePlatformUserHeader(req);
    }
    return requireEdgeGuardianAuthByActorPrincipal(req, server);
  }

  function validateEdgeBearer(
    req: Request,
    token: string,
    server?: Server<unknown>,
  ): Response | null {
    const result = validateEdgeToken(token);
    if (!result.ok) {
      if (
        allowLegacyLoopbackFallback(req, server, "edge", {
          authFailure: "token_validation_failed",
          reason: result.reason,
        })
      ) {
        return null;
      }
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
    server?: Server<unknown>,
  ): Response | null {
    const result = validateEdgeToken(token);
    if (!result.ok) {
      if (
        allowLegacyLoopbackFallback(req, server, "edge-scoped", {
          authFailure: "token_validation_failed",
          reason: result.reason,
          scope,
        })
      ) {
        return null;
      }
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
      if (
        allowLegacyLoopbackFallback(req, server, "edge-scoped", {
          authFailure: "insufficient_scope",
          scope,
        })
      ) {
        return null;
      }
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
    return null;
  }

  function rejectMissingAuthorization(
    req: Request,
    label: string,
    server: Server<unknown> | undefined,
    guard: string,
    extra?: Record<string, unknown>,
  ): Response | null {
    if (
      allowLegacyLoopbackFallback(req, server, guard, {
        authFailure: "missing_authorization",
        ...extra,
      })
    ) {
      return null;
    }
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
    server: Server<unknown> | undefined,
    guard: string,
    extra?: Record<string, unknown>,
  ): Response | null {
    if (
      allowLegacyLoopbackFallback(req, server, guard, {
        authFailure: "malformed_authorization",
        ...extra,
      })
    ) {
      return null;
    }
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

  function allowLegacyLoopbackFallback(
    req: Request,
    server: Server<unknown> | undefined,
    guard: string,
    extra?: Record<string, unknown>,
  ): boolean {
    if (requestArrivedViaEdgeProxy(req)) return false;

    // When a trusted reverse proxy is declared, judge loopback-ness by the
    // real client IP (first X-Forwarded-For entry) rather than the raw socket
    // peer. A same-host proxy/tunnel always connects over 127.0.0.1, so without
    // this a proxied remote caller would be misclassified as local and granted
    // the loopback grace period. trustProxy defaults false, so direct-loopback
    // local clients (no X-Forwarded-For) are unaffected. See is-loopback-address.ts.
    if (!server || !isLoopbackPeer(server, req, { trustProxy })) return false;

    const path = new URL(req.url).pathname;

    if (
      loopbackFallbackLogThrottle.shouldLog(
        `${guard} ${path} ${typeof extra?.authFailure === "string" ? extra.authFailure : "unspecified"}`,
      )
    ) {
      const peer = server.requestIP(req);
      log.warn(
        {
          path,
          guard,
          peerIp: peer?.address,
          authFallback: "legacy_loopback",
          ...extra,
        },
        "Gateway auth allowed via legacy loopback fallback after gateway auth did not succeed (throttled to one log per endpoint per hour)",
      );
    }
    return true;
  }

  /**
   * Default path — validate JWT, require actor principal, assert it matches
   * the bound cadet guardian.
   */
  async function requireEdgeGuardianAuthByActorPrincipal(
    req: Request,
    server?: Server<unknown>,
  ): Promise<Response | null> {
    const token = extractBearerToken(req);
    if (!token) {
      if (
        allowLegacyLoopbackFallback(req, server, "edge-guardian", {
          authFailure: hasAuthorizationHeader(req)
            ? "malformed_authorization"
            : "missing_authorization",
        })
      ) {
        return null;
      }
      authRateLimiter.recordFailure(getClientIp());
      log.warn(
        { path: new URL(req.url).pathname },
        "Guardian edge auth rejected: missing or malformed Authorization header",
      );
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const result = validateEdgeToken(token);
    if (!result.ok) {
      if (
        allowLegacyLoopbackFallback(req, server, "edge-guardian", {
          authFailure: "token_validation_failed",
          reason: result.reason,
        })
      ) {
        return null;
      }
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
      if (
        allowLegacyLoopbackFallback(req, server, "edge-guardian", {
          authFailure: "non_actor_principal",
        })
      ) {
        return null;
      }
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
      if (
        allowLegacyLoopbackFallback(req, server, "edge-guardian", {
          authFailure: "guardian_mismatch",
        })
      ) {
        return null;
      }
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
 * Extract the raw token from a Bearer Authorization header, or null.
 *
 * A bearer-less request falls back to the browser access cookie
 * (`cadet_web_access`): the served web UI holds no credential in JS — its
 * token lives in an HttpOnly cookie set at pairing, so every edge request
 * authenticates through this same pipeline (signature, revocation, guardian
 * binding) with the cookie standing in for the header. A malformed cookie
 * fails validation exactly like a malformed bearer, recording the same auth
 * failure.
 */
function extractBearerToken(req: Request): string | null {
  const authHeader = req.headers.get("authorization");
  if (authHeader?.toLowerCase().startsWith("bearer ")) {
    return authHeader.slice(7);
  }
  const cookieToken = getRemoteWebAccessCookie(req);
  return cookieToken || null;
}

function hasAuthorizationHeader(req: Request): boolean {
  return Boolean(req.headers.get("authorization")?.trim());
}
