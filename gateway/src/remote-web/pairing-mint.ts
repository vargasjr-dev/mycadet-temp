/**
 * Mint-and-approve for the remote-web pairing flow — executed DIRECTLY in
 * the calling process (the `gateway pairing mint` CLI), deliberately NOT
 * exposed over the gateway's IPC socket: the assistant daemon shares that
 * socket, and an IPC-exposed mint would let the assistant mint + approve
 * pairings for itself, defeating the local-presence proof. Challenges
 * persist to the file-backed pairing store under GATEWAY_SECURITY_DIR, so
 * the RUNNING gateway's verification and token-exchange routes see what
 * this mints.
 *
 * This is the exact sequence the loopback HTTP mint used to run (parse →
 * rate-limit → capacity → create → approve), with the requester metadata
 * honestly naming the CLI invocation instead of an HTTP peer.
 */

import type { RemoteWebPairingChallengeResponse } from "@mycadet/service-contracts/remote-web-pairing";

import { parsePublicBaseUrl } from "../http/routes/remote-web-pairing-challenge.js";
import { recordRemoteWebPairingChallengeCreation } from "./pairing-challenge-rate-limit-store.js";
import {
  approveRemoteWebPairingChallenge,
  checkRemoteWebPairingChallengeCapacity,
  createRemoteWebPairingChallenge,
  type RemoteWebPairingChallengeCapacityLimit,
} from "./pairing-challenge-store.js";

/**
 * Client-facing failure with a stable code (BAD_REQUEST, RATE_LIMITED,
 * PAIRING_CHALLENGE_CAPACITY_EXCEEDED, MINT_APPROVAL_FAILED).
 */
export class PairingMintError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "PairingMintError";
    this.code = code;
  }
}

function rateLimitError(retryAfterSeconds: number): PairingMintError {
  return new PairingMintError(
    `too many remote web pairing challenges; retry in ${retryAfterSeconds}s`,
    "RATE_LIMITED",
  );
}

function capacityLimitError(
  limit: RemoteWebPairingChallengeCapacityLimit,
): PairingMintError {
  return new PairingMintError(
    `too many pending remote web pairing challenges; retry in ${limit.retryAfterSeconds}s`,
    "PAIRING_CHALLENGE_CAPACITY_EXCEEDED",
  );
}

export function mintAndApproveRemoteWebPairingChallenge(
  publicBaseUrlRaw: string,
): RemoteWebPairingChallengeResponse {
  const publicBaseUrl = parsePublicBaseUrl(publicBaseUrlRaw);
  if (!publicBaseUrl) {
    throw new PairingMintError(
      "publicBaseUrl is required (an http(s) URL with a host)",
      "BAD_REQUEST",
    );
  }

  const rateLimited = recordRemoteWebPairingChallengeCreation();
  if (rateLimited) throw rateLimitError(rateLimited.retryAfterSeconds);

  const capacityLimited = checkRemoteWebPairingChallengeCapacity();
  if (capacityLimited) throw capacityLimitError(capacityLimited);

  // The requester fields back the host approval UI; a direct mint has no
  // HTTP peer to report, so the honest provenance is the CLI invocation
  // itself.
  const challenge = createRemoteWebPairingChallenge(publicBaseUrl, {
    ip: "cli",
    userAgent: null,
    viaEdgeProxy: false,
  });

  const approved = approveRemoteWebPairingChallenge(challenge.userCode);
  if (approved.status !== "approved") {
    // Unreachable for a challenge minted this tick, but fail loudly rather
    // than hand out an unapproved link.
    throw new PairingMintError(
      `minted challenge could not be approved (${approved.status})`,
      "MINT_APPROVAL_FAILED",
    );
  }

  return challenge;
}
