/**
 * `gateway pairing` — operator subcommands for the remote-web pairing flow.
 *
 *   gateway pairing mint <url>
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
 */

import { mintAndApproveRemoteWebPairingChallenge } from "../remote-web/pairing-mint.js";

function printUsage(): void {
  console.log("Usage: gateway pairing mint <url>");
  console.log("");
  console.log(
    "Mint and approve a remote-web pairing challenge on this machine and",
  );
  console.log("print the challenge as JSON.");
  console.log("");
  console.log("Arguments:");
  console.log("  <url>   Public base URL to advertise in the pairing link,");
  console.log("          e.g. https://your-assistant.ts.net");
}

/** Parse `pairing` argv (after the command word) into a subcommand + arg. */
export function parsePairingArgs(args: string[]): {
  subcommand: string | null;
  positional: string | null;
} {
  const [subcommand = null, positional = null] = args;
  return { subcommand, positional };
}

export async function runPairingCommand(args: string[]): Promise<number> {
  const { subcommand, positional } = parsePairingArgs(args);

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printUsage();
    return subcommand ? 0 : 1;
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
