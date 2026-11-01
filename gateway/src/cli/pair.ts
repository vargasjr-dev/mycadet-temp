/**
 * `gateway pair` — the guardian lease's device-bound pair door.
 *
 *   gateway pair --platform <p> --device-id <id> [--client-reported-name <n>]
 *
 * Executes the pair mint logic DIRECTLY in this process (the same bootstrap
 * semantics as the pair route's cli branch: resolving-or-minting the guardian
 * with the caller's execution as the evidence) — deliberately NOT over HTTP:
 * process execution is the local-presence proof, so no loopback-peer check is
 * needed and the topology (native or containerized) stops mattering. Prints
 * the device-bound pair payload as single-line JSON on stdout; the client's
 * pair operation parses it (its last stdout line).
 */

import { mintCliPairPayload } from "../http/routes/pair.js";

function printUsage(): void {
  console.log("Usage: gateway pair [options]");
  console.log("");
  console.log(
    "Mint a device-bound guardian credential, printing the pair payload",
  );
  console.log("as single-line JSON. Process execution is the presence proof.");
  console.log("");
  console.log("Options:");
  console.log(
    "  --platform <p>                The pairing platform (e.g. cli)",
  );
  console.log(
    "  --device-id <id>              The device id the credential binds to (required)",
  );
  console.log(
    "  --client-reported-name <n>    The device's self-reported name",
  );
  console.log("");
  console.log("Examples:");
  console.log("  $ gateway pair --platform cli --device-id device-1");
  console.log(
    "  From the host: cadet exec --service gateway -- gateway pair ...",
  );
}

/** Parse `pair` argv into the mint options; null on a bad invocation. */
export function parsePairArgs(args: string[]): {
  platform: string;
  deviceId: string | null;
  clientReportedName?: string;
} | null {
  let platform = "cli";
  let deviceId: string | null = null;
  let clientReportedName: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag === "--platform" && value) {
      platform = value;
      i++;
    } else if (flag === "--device-id" && value) {
      deviceId = value;
      i++;
    } else if (flag === "--client-reported-name" && value) {
      clientReportedName = value;
      i++;
    } else if (flag === "--help" || flag === "-h") {
      return null;
    }
  }
  return { platform, deviceId, clientReportedName };
}

export async function runPairCommand(args: string[]): Promise<number> {
  const parsed = parsePairArgs(args);
  if (!parsed || !parsed.deviceId) {
    if (parsed === null) {
      printUsage();
      return 0;
    }
    console.error("Error: --device-id is required (pairing is device-scoped).");
    return 1;
  }

  try {
    const payload = await mintCliPairPayload({
      deviceId: parsed.deviceId,
      platform: parsed.platform,
      clientReportedName: parsed.clientReportedName,
    });
    console.log(JSON.stringify(payload));
    return 0;
  } catch (err) {
    console.error(
      `Error: could not pair (${
        err instanceof Error ? err.message : String(err)
      }).`,
    );
    return 1;
  }
}
