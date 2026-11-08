/**
 * Generic loopback pairing + shared-invite redemption route declarations
 * (dispatch-only — never published in the spec). Unauthenticated by design:
 * the pairing challenge/token flow and the invite-link redemption are the
 * credentials themselves.
 */

import { handleCreateRemoteWebPairingChallenge } from "./remote-web-pairing-challenge.js";
import { handleVerifyRemoteWebPairingChallenge } from "./remote-web-pairing-verification.js";
import { handleRemoteWebPairingToken } from "./remote-web-pairing-token.js";
import { handleSharedInviteRedeem } from "./shared-invite-redeem.js";
import type { RouteDefinition } from "./types.js";

export const ROUTES: RouteDefinition[] = [
  {
    path: "/remote-web/pairing-challenge",
    method: "post",
    handler: (req, _params, getClientIp) =>
      handleCreateRemoteWebPairingChallenge(req, getClientIp()),
  },
  {
    path: "/remote-web/pairing-verification",
    method: "post",
    handler: (req, _params, getClientIp) =>
      handleVerifyRemoteWebPairingChallenge(req, getClientIp()),
  },
  {
    path: "/remote-web/pairing-token",
    method: "post",
    handler: (req) => handleRemoteWebPairingToken(req),
  },
  {
    // The invite link token in the request body is the credential.
    path: "/shared/invites/redeem",
    method: "post",
    handler: (req, _params, getClientIp) =>
      handleSharedInviteRedeem(req, getClientIp()),
  },
];
