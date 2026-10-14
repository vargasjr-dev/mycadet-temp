/**
 * `gateway pairing` — operator subcommands for the remote-web pairing flow.
 *
 *   gateway pairing mint <url>
 *   gateway pairing list [--json]
 *
 * Mints (and approves) a remote-web pairing challenge by executing the
 * pairing mint logic DIRECTLY in this process — deliberately NOT over the
 * gateway's IPC socket, which the assistant daemon shares (an IPC-exposed
 * mint would let the assistant mint + approve pairings for itself). The
 * challenge persists to the file-backed pairing store under
 * GATEWAY_SECURITY_DIR, so the running gateway's verification and
 * token-exchange routes see it. This is the surface `cadet pair` invokes
 * (directly on the host, or via `docker exec` inside the gateway container):
 * process execution is the local-presence proof, so no loopback-peer check
 * is needed and the topology (native or containerized) stops mattering.
 * Prints the challenge response as single-line JSON on stdout; the caller
 * parses it and renders the pairing link/QR.
 *
 * `list` reads the same file-backed store and reports EVERY persisted
 * challenge — active and expired — with each one's mint and expiration
 * timestamp, so the host can see in-flight and stale pairing sessions.
 */

import {
  listPersistedRemoteWebPairingChallenges,
  type PendingRemoteWebPairingChallenge,
} from "../remote-web/pairing-challenge-store.js";
import { mintAndApproveRemoteWebPairingChallenge } from "../remote-web/pairing-mint.js";

function printUsage(): void {
  console.log("Usage: gateway pairing <subcommand>");
  console.log("");
  console.log("Operator commands for the remote-web pairing flow.");
  console.log("");
  console.log("Subcommands:");
  console.log(
    "  mint <url>   Mint and approve a pairing challenge; prints the",
  );
  console.log(
    "               challenge (device code, pairing link, expiry) as JSON.",
  );
  console.log(
    "  list         List every persisted pairing challenge — active and",
  );
  console.log(
    "               expired — with its mint and expiration timestamp.",
  );
  console.log("");
  console.log("Options:");
  console.log("  --json       Machine-readable JSON (list)");
  console.log("");
  console.log("Examples:");
  console.log("  $ gateway pairing mint https://your-assistant.ts.net");
  console.log("  $ gateway pairing list");
  console.log("  $ gateway pairing list --json");
  console.log("");
  console.log("From the host: cadet exec --service gateway -- gateway pairing list");
}

/** Parse `pairing` argv (after the command word) into a subcommand + arg. */
export function parsePairingArgs(args: string[]): {
  subcommand: string | null;
  positional: string | null;
} {
  const [subcommand = null, positional = null] = args;
  return { subcommand, positional };
}

function listLiveness(
  challenge: PendingRemoteWebPairingChallenge,
  now: number,
): "active" | "expired" {
  return challenge.expiresAtMs <= now ? "expired" : "active";
}

function runPairingList(json: boolean): number {
  const now = Date.now();
  const challenges = listPersistedRemoteWebPairingChallenges();

  if (json) {
    console.log(
      JSON.stringify({
        ok: true,
        challenges: challenges.map((challenge) => ({
          ...challenge,
          expired: challenge.expiresAtMs <= now,
        })),
      }),
    );
    return 0;
  }

  if (challenges.length === 0) {
    console.log("No pairing challenges found.");
    return 0;
  }

  for (const challenge of challenges) {
    const liveness = listLiveness(challenge, now);
    console.log(
      `${challenge.userCode}  ${challenge.status}  ${liveness}  ` +
        `minted ${new Date(challenge.createdAtMs).toISOString()}  ` +
        `expires ${new Date(challenge.expiresAtMs).toISOString()}`,
    );
    const userAgent = challenge.requesterUserAgent
      ? `  ${challenge.requesterUserAgent}`
      : "";
    console.log(
      `  ${challenge.verificationUri}  requester ${challenge.requesterIp}${userAgent}`,
    );
  }
  return 0;
}

export async function runPairingCommand(args: string[]): Promise<number> {
  const { subcommand, positional } = parsePairingArgs(args);

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printUsage();
    return subcommand ? 0 : 1;
  }
  if (subcommand === "list") {
    return runPairingList(args.includes("--json"));
  }
  if (subcommand !== "mint") {
    console.error(`Error: unknown pairing subcommand '${subcommand}'.`);
    printUsage();
    return 1;
  }
  if (!positional) {
    console.error("Error: mint requires the public base URL to advertise.");
    printUsage();
    return 1;
  }

  try {
    const challenge = mintAndApproveRemoteWebPairingChallenge(positional);
    console.log(JSON.stringify(challenge));
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: pairing mint failed: ${message}`);
    return 1;
  }
}
