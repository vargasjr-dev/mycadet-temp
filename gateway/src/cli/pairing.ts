/**
 * `gateway pairing` — operator subcommands for the remote-web pairing flow.
 *
 *   gateway pairing mint <url>
 *
 * Mints (and approves) a remote-web pairing challenge by talking to the
 * RUNNING gateway over its IPC socket — no HTTP involved. This is the surface
 * `cadet pair` invokes (directly on the host, or via `docker exec` inside the
 * gateway container): process execution is the local-presence proof, so no
 * loopback-peer check is needed and the topology (native or containerized)
 * stops mattering. Prints the challenge response as single-line JSON on
 * stdout; the caller parses it and renders the pairing link/QR.
 */

import { PersistentIpcClient } from "@mycadet/gateway-client";

import { resolveIpcSocketPath } from "../ipc/endpoint.js";
import { PAIRING_MINT_IPC_METHOD } from "../ipc/pairing-handlers.js";

function printUsage(): void {
  console.log("Usage: gateway pairing mint <url>");
  console.log("");
  console.log(
    "Mint and approve a remote-web pairing challenge on the running gateway",
  );
  console.log("(via its IPC socket) and print the challenge as JSON.");
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

  const { path: socketPath, source } = resolveIpcSocketPath("gateway");
  // Fail fast: a CLI invocation either reaches the running gateway now or
  // reports the miss — no sibling-boot retry budget here.
  const client = new PersistentIpcClient(socketPath, 10_000, undefined, {
    connectRetryBackoffsMs: [],
  });
  try {
    const result = await client.call(PAIRING_MINT_IPC_METHOD, {
      publicBaseUrl: positional,
    });
    if (result === undefined || result === null) {
      console.error(
        `Error: the gateway returned no challenge (socket: ${socketPath}, source: ${source}).`,
      );
      return 1;
    }
    console.log(JSON.stringify(result));
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: pairing mint failed: ${message}`);
    console.error(`(gateway IPC socket: ${socketPath}, source: ${source})`);
    return 1;
  } finally {
    client.destroy();
  }
}
