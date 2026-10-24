/**
 * Identity resolution for the runtime HTTP server.
 *
 * The daemon does not verify tokens. The gateway is the sole
 * authentication point: it verifies edge credentials (actor JWTs, OAuth
 * grants) and forwards the trusted identity upstream in `x-cadet-*`
 * headers, re-derived from the verified claims — never passed through
 * from the caller (see gateway/src/http/routes/runtime-proxy.ts and
 * ipc-runtime-proxy.ts, which both strip caller-supplied values first).
 *
 * The daemon's port is host-only — loopback-bound on the desktop,
 * loopback-published in docker — so every dialer of the HTTP surface is
 * the gateway or a process inside the host trust boundary. The gateway's
 * edge is the only remote ingress; a request without forwarded identity
 * is refused.
 *
 * When DISABLE_HTTP_AUTH is set (cloud-managed deployments), a request
 * with no identity headers gets the dev-bypass actor context so
 * downstream code always has a typed context to consume. A request that
 * carries identity headers resolves to them normally.
 */

import { isHttpAuthDisabled } from "../../config/env.js";
import { getLogger } from "../../util/logger.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../assistant-scope.js";
import { buildAuthContext } from "./context.js";
import { CURRENT_POLICY_EPOCH } from "./policy.js";
import { resolveScopeProfile } from "./scopes.js";
import { parseSub } from "./subject.js";
import type { AuthContext, TokenClaims } from "./types.js";

const log = getLogger("auth-middleware");

// ---------------------------------------------------------------------------
// Forwarded identity headers
//
// The same vocabulary the gateway's IPC proxy uses, plus the scope
// profile so route policies can enforce the verified grant downstream.
// ---------------------------------------------------------------------------

/** The subject header the gateway sets from the verified token's `sub`. */
export const SUBJECT_HEADER = "x-cadet-subject";
/** The principal-type header the gateway sets from the verified subject. */
export const PRINCIPAL_TYPE_HEADER = "x-cadet-principal-type";
/** The scope-profile header the gateway sets from the verified token. */
export const SCOPE_PROFILE_HEADER = "x-cadet-scope-profile";

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export type AuthenticateResult =
  | { ok: true; context: AuthContext }
  | { ok: false; response: Response };

// ---------------------------------------------------------------------------
// Synthetic contexts
// ---------------------------------------------------------------------------

/**
 * Construct a synthetic AuthContext for dev mode when auth is bypassed.
 * Grants the broadest profile so all routes are accessible during
 * local development.
 */
function buildDevBypassContext(): AuthContext {
  return {
    subject: `actor:${DAEMON_INTERNAL_ASSISTANT_ID}:dev-bypass`,
    principalType: "actor",
    assistantId: DAEMON_INTERNAL_ASSISTANT_ID,
    actorPrincipalId: "dev-bypass",
    scopeProfile: "actor_client_v1",
    scopes: resolveScopeProfile("actor_client_v1"),
    policyEpoch: Number.MAX_SAFE_INTEGER,
  };
}

// ---------------------------------------------------------------------------
// Forwarded-identity context
// ---------------------------------------------------------------------------

/**
 * Build an AuthContext from the gateway-forwarded identity headers.
 *
 * The subject header is the source of truth: it is run through the same
 * subject grammar the verified claims were minted against, so principal
 * type, actor principal id, and conversation id all derive from one
 * value. The principal-type header must agree — the gateway sets both
 * from the same verified claims, and a disagreement means a mangled hop.
 */
export function buildAuthContextFromForwardedIdentity(headers: Headers):
  | { ok: true; context: AuthContext }
  | { ok: false; reason: string } {
  const subject = headers.get(SUBJECT_HEADER)?.trim();
  const principalTypeHeader = headers.get(PRINCIPAL_TYPE_HEADER)?.trim();

  if (!subject) {
    return { ok: false, reason: "no_forwarded_identity" };
  }

  const subResult = parseSub(subject);
  if (!subResult.ok) {
    return { ok: false, reason: subResult.reason };
  }
  if (principalTypeHeader && principalTypeHeader !== subResult.principalType) {
    return {
      ok: false,
      reason: `forwarded_identity_mismatch: subject says ${subResult.principalType}, header says ${principalTypeHeader}`,
    };
  }

  // The profile rides its own header. An unrecognized value resolves to
  // no scopes — the fail-closed floor (the same contract the JWT claims
  // had: claims come from JSON, profiles are resolved, never trusted).
  // The gateway sets the header on every proxied request.
  const scopeProfileHeader = headers.get(SCOPE_PROFILE_HEADER)?.trim() ?? "";
  const claims: TokenClaims = {
    iss: "cadet-auth",
    aud: "cadet-daemon",
    sub: subject,
    scope_profile: scopeProfileHeader as TokenClaims["scope_profile"],
    exp: 0,
    policy_epoch: CURRENT_POLICY_EPOCH,
    iat: 0,
    jti: "",
  };

  return buildAuthContext(claims);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Resolve the caller identity of an incoming HTTP request.
 *
 * Returns an AuthContext on success, or an error Response on failure.
 * The caller should return the error Response directly to the client.
 */
export function authenticateRequest(req: Request): AuthenticateResult {
  const path = new URL(req.url).pathname;
  const forwarded = buildAuthContextFromForwardedIdentity(req.headers);
  if (forwarded.ok) {
    return forwarded;
  }

  if (forwarded.reason !== "no_forwarded_identity") {
    log.warn(
      { reason: forwarded.reason, path },
      "Auth denied: forwarded identity rejected",
    );
    return {
      ok: false,
      response: Response.json(
        {
          error: {
            code: "UNAUTHORIZED",
            message: `Invalid identity: ${forwarded.reason}`,
          },
        },
        { status: 401 },
      ),
    };
  }

  // No forwarded identity: the daemon's port is host-only, so this is
  // either a platform-managed deployment (auth disabled — dev-bypass
  // context) or a request the gateway never touched (refused).
  if (isHttpAuthDisabled()) {
    return { ok: true, context: buildDevBypassContext() };
  }

  log.warn(
    { reason: "missing_identity", path },
    "Auth denied: no forwarded identity headers",
  );
  return {
    ok: false,
    response: Response.json(
      {
        error: {
          code: "UNAUTHORIZED",
          message: "Missing identity headers",
        },
      },
      { status: 401 },
    ),
  };
}
