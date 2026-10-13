/**
 * IPC route definitions for gateway-side remote-web pairing mints.
 *
 * `cadet pair` reaches this through the `gateway pairing mint <url>` CLI
 * running on the assistant's host, or through `docker exec` of that same CLI
 * inside the gateway container — never over the network. Process execution is
 * the local-presence proof, replacing the loopback-peer HTTP gate the mint
 * used to require (which containerized gateways could never satisfy:
 * published-port NAT rewrites every host-originated peer to the bridge
 * address, so a strictly-loopback check always denied).
 *
 * Minting through this route approves the challenge on the spot — the CLI
 * invocation IS the approval, exactly like the old loopback HTTP
 * mint-then-verify pair — so scanning the printed link completes pairing in
 * one step. The verification, token-exchange, and request-approval surfaces
 * are unchanged: they keep their own gates and read the same in-memory
 * challenge store this route writes.
 */

import { z } from "zod";

import {
  approveRemoteWebPairingChallenge,
  checkRemoteWebPairingChallengeCapacity,
  createRemoteWebPairingChallenge,
  type RemoteWebPairingChallengeCapacityLimit,
} from "../remote-web/pairing-challenge-store.js";
import { recordRemoteWebPairingChallengeCreation } from "../remote-web/pairing-challenge-rate-limit-store.js";
import { parsePublicBaseUrl } from "../http/routes/remote-web-pairing-challenge.js";
import type { IpcRoute } from "./server.js";

export const PAIRING_MINT_IPC_METHOD = "pairing_mint";

const PairingMintParamsSchema = z.object({
  publicBaseUrl: z.string().min(1),
});

/**
 * Client-facing failure with a stable code + HTTP-style status, mirrored by
 * the IPC server into the wire response (`statusCode`/`errorCode`) the same
 * way the invite handlers' typed errors are.
 */
class PairingMintError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(message: string, statusCode: number, code: string) {
    super(message);
    this.name = "PairingMintError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

function rateLimitError(retryAfterSeconds: number): PairingMintError {
  return new PairingMintError(
    `too many remote web pairing challenges; retry in ${retryAfterSeconds}s`,
    429,
    "RATE_LIMITED",
  );
}

function capacityLimitError(
  limit: RemoteWebPairingChallengeCapacityLimit,
): PairingMintError {
  return new PairingMintError(
    `too many pending remote web pairing challenges; retry in ${limit.retryAfterSeconds}s`,
    429,
    "PAIRING_CHALLENGE_CAPACITY_EXCEEDED",
  );
}

export function createPairingIpcRoutes(): IpcRoute[] {
  return [
    {
      method: PAIRING_MINT_IPC_METHOD,
      schema: PairingMintParamsSchema,
      handler: (params?: Record<string, unknown>) => {
        const { publicBaseUrl: rawPublicBaseUrl } =
          PairingMintParamsSchema.parse(params);

        const publicBaseUrl = parsePublicBaseUrl(rawPublicBaseUrl);
        if (!publicBaseUrl) {
          throw new PairingMintError(
            "publicBaseUrl is required (an http(s) URL with a host)",
            400,
            "BAD_REQUEST",
          );
        }

        const rateLimited = recordRemoteWebPairingChallengeCreation();
        if (rateLimited) throw rateLimitError(rateLimited.retryAfterSeconds);

        const capacityLimited = checkRemoteWebPairingChallengeCapacity();
        if (capacityLimited) throw capacityLimitError(capacityLimited);

        // The in-memory requester fields back the host approval UI; an IPC
        // mint has no HTTP peer to report, so the honest provenance is the
        // CLI invocation itself.
        const challenge = createRemoteWebPairingChallenge(publicBaseUrl, {
          ip: "cli",
          userAgent: null,
          viaEdgeProxy: false,
        });

        const approved = approveRemoteWebPairingChallenge(challenge.userCode);
        if (approved.status !== "approved") {
          // Unreachable for a challenge minted this tick, but fail loudly
          // rather than hand out an unapproved link.
          throw new PairingMintError(
            `minted challenge could not be approved (${approved.status})`,
            500,
            "MINT_APPROVAL_FAILED",
          );
        }

        return challenge;
      },
    },
  ];
}
