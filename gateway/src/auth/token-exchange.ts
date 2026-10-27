/**
 * Token exchange module for the gateway's auth system.
 *
 * The gateway receives edge tokens (aud=cadet-gateway) from external
 * clients and forwards the verified identity to the runtime in
 * `x-cadet-*` headers — the daemon verifies no tokens. The gateway is
 * the only signer: it holds the signing key for the edge tokens it
 * mints (relay dials, browser page tokens) and for nothing else.
 */

import { getLogger } from "../logger.js";

import { CURRENT_POLICY_EPOCH } from "./policy.js";
import { parseSub } from "./subject.js";
import { mintToken, verifyToken, type VerifyResult } from "./token-service.js";
import type { ForwardedIdentity } from "@mycadet/assistant-client";
import type { ScopeProfile, TokenClaims } from "./types.js";

const log = getLogger("token-exchange");

// ---------------------------------------------------------------------------
// Edge token validation
// ---------------------------------------------------------------------------

/**
 * Validate a JWT edge token intended for the gateway (aud=cadet-gateway).
 *
 * Returns the verified claims on success, or a structured error on failure.
 * Pass `allowExpired: true` to accept expired-but-otherwise-valid tokens
 * (signature, audience, and policy epoch are still checked). This is used
 * by the refresh endpoint so clients can obtain new credentials even after
 * the access token has expired.
 */
export function validateEdgeToken(
  token: string,
  opts?: { allowExpired?: boolean },
): VerifyResult {
  return verifyToken(token, "cadet-gateway", opts);
}

// ---------------------------------------------------------------------------
// Forwarded identity
// ---------------------------------------------------------------------------

/**
 * Rewrite an edge sub's assistant segment to 'self', the daemon's internal
 * scope constant. Service and unparseable subs become the gateway service sub.
 */
export function toDaemonSubject(edgeSub: string): string {
  const parsed = parseSub(edgeSub);

  if (!parsed.ok) {
    log.warn(
      { sub: edgeSub, reason: parsed.reason },
      "Failed to parse edge token sub, using gateway service sub",
    );
    return "svc:gateway:self";
  }

  switch (parsed.principalType) {
    case "actor":
      return `actor:self:${parsed.actorPrincipalId}`;
    case "local":
      return `local:self:${parsed.conversationId}`;
    default:
      return "svc:gateway:self";
  }
}

/**
 * The identity the runtime should see for a verified edge caller: the
 * sub rewritten to the daemon's internal scope, carrying the profile the
 * edge token was minted with (the daemon resolves the same profile's
 * scopes, so its route policies see exactly what the edge admitted).
 */
export function forwardedIdentityFromClaims(
  edgeClaims: TokenClaims,
  targetScopeProfile: ScopeProfile,
): ForwardedIdentity {
  const subject = toDaemonSubject(edgeClaims.sub);
  const parsed = parseSub(subject);
  return {
    subject,
    principalType: parsed.ok ? parsed.principalType : "svc_gateway",
    scopeProfile: targetScopeProfile,
  };
}

// ---------------------------------------------------------------------------
// Gateway-minted edge tokens
// ---------------------------------------------------------------------------

/** TTL for the gateway's own short-lived edge tokens. */
const EXCHANGE_TOKEN_TTL_SECONDS = 60;

/**
 * Mint a relay token for Twilio WebSocket connections.
 *
 * The gateway's relay/media-stream WS handlers validate these tokens via
 * {@link validateEdgeToken} (aud=cadet-gateway). Previously minted by the
 * daemon and embedded in TwiML; now minted by the gateway and injected into
 * the TwiML response before it reaches Twilio.
 *
 * sub=svc:gateway:self, scope_profile=gateway_service_v1
 */
export function mintRelayToken(): string {
  return mintToken({
    aud: "cadet-gateway",
    sub: "svc:gateway:self",
    scope_profile: "gateway_service_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds: EXCHANGE_TOKEN_TTL_SECONDS,
  });
}

/**
 * Mint a JWT for embedding in browser-served UI pages (brain-graph).
 *
 * The daemon returns HTML containing a placeholder; the gateway replaces it
 * with this token before serving the page. Uses the ui_page_v1 scope profile
 * which grants only settings.read — the minimum needed for the brain-graph
 * data endpoint. 1-hour TTL gives users time to interact with the page.
 */
export function mintUiPageToken(): string {
  return mintToken({
    aud: "cadet-gateway",
    sub: "svc:gateway:self",
    scope_profile: "ui_page_v1",
    policy_epoch: CURRENT_POLICY_EPOCH,
    ttlSeconds: 3600,
  });
}
