/**
 * `gateway pairing` — operator subcommands for the pairing flows.
 *
 *   gateway pairing mint [--device-id <id> [--platform <p>] [--client-reported-name <n>]]
 *   gateway pairing list [--json]
 *   gateway pairing approve <requestId>
 *   gateway pairing deny <requestId>
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
 * With --device-id the mint is the guardian lease's door instead: the
 * device-bound credential (the same mint the pair route's cli branch runs —
 * the guardian resolves or mints with the caller's execution as evidence)
 * executes directly in this process and prints as single-line JSON. Process
 * execution is the presence proof and a self-exchange needs no link, so no
 * loopback-peer check applies and no saved ingress url is required.
 * Anything pairing-related mints through THIS command — there is no
 * separate pair verb.
 *
 * `list` reads the same file-backed store and reports EVERY persisted
 * challenge — active and expired — with each one's mint and expiration
 * timestamp, so the host can see in-flight and stale pairing sessions.
 */

import { mintPairingPayload } from "../http/routes/pair.js";
import {
  approveRemoteWebPairingChallengeById,
  denyRemoteWebPairingChallengeById,
  listPersistedRemoteWebPairingChallenges,
  type PendingRemoteWebPairingChallenge,
} from "../remote-web/pairing-challenge-store.js";
import { mintAndApproveRemoteWebPairingChallenge } from "../remote-web/pairing-mint.js";
import { readSavedIngressPublicBaseUrl } from "../remote-web/public-base-url.js";

function printUsage(): void {
  console.log("Usage: gateway pairing <subcommand>");
  console.log("");
  console.log("Operator commands for the remote-web pairing flow.");
  console.log("");
  console.log("Subcommands:");
  console.log(
    "  mint         Mint and approve a pairing challenge advertising the",
  );
  console.log(
    "               saved ingress url; prints the challenge (device code,",
  );
  console.log(
    "               pairing link, expiry) as JSON. With --device-id <id>,",
  );
  console.log(
    "               mint the device-bound guardian credential instead and",
  );
  console.log(
    "               print it as single-line JSON (the guardian lease's door).",
  );
  console.log(
    "  list         List every persisted pairing challenge — active and",
  );
  console.log(
    "               expired — with its mint and expiration timestamp.",
  );
  console.log(
    "  approve <id> Approve a pending pairing request minted elsewhere",
  );
  console.log("               (e.g. the public /account/pair page).");
  console.log("  deny <id>    Deny (delete) a pending pairing request by id.");
  console.log("");
  console.log("Options:");
  console.log("  --json       Machine-readable JSON (list)");
  console.log(
    "  --device-id <id>            Mint the device-bound credential (mint)",
  );
  console.log(
    "  --platform <p>              The pairing platform (device-bound mint)",
  );
  console.log("  --client-reported-name <n>  The device's self-reported name");
  console.log("");
  console.log("Examples:");
  console.log("  $ gateway pairing mint");
  console.log("  $ gateway pairing mint --device-id device-1");
  console.log("  $ gateway pairing list");
  console.log("  $ gateway pairing list --json");
  console.log("  $ gateway pairing approve <requestId>");
  console.log("  $ gateway pairing deny <requestId>");
  console.log("");
  console.log(
    "From the host: cadet exec --service gateway -- gateway pairing list",
  );
}

/** Parse `pairing` argv (after the command word) into a subcommand + arg. */
export function parsePairingArgs(args: string[]): {
  subcommand: string | null;
  positional: string | null;
} {
  const [subcommand = null, positional = null] = args;
  return { subcommand, positional };
}

/**
 * Parse `pairing mint` argv into the device-bound mint options. A `--device-id`
 * selects the device-bound arm (the guardian lease's door); without one the
 * mint falls through to the remote-web challenge flow. Unknown flags are
 * ignored — the challenge flow takes no options, and a typo'd flag degrades
 * to the plain mint rather than erroring a lease that never passed it.
 */
export function parsePairingMintArgs(args: string[]): {
  deviceId: string | null;
  platform: string;
  clientReportedName?: string;
} {
  let deviceId: string | null = null;
  let platform = "cli";
  let clientReportedName: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag === "--device-id" && value) {
      deviceId = value;
      i++;
    } else if (flag === "--platform" && value) {
      platform = value;
      i++;
    } else if (flag === "--client-reported-name" && value) {
      clientReportedName = value;
      i++;
    }
  }
  return { deviceId, platform, clientReportedName };
}

/**
 * The workspace's saved public ingress url — written by `cadet tunnel start`
 * (and re-recorded by the gateway's own /v1/ingress/domains handler). The
 * mint self-sources it: this CLI runs where the workspace lives, so no
 * caller needs to pass a URL.
 */
function listLiveness(
  challenge: PendingRemoteWebPairingChallenge,
  now: number,
): "active" | "expired" {
  return challenge.expiresAtMs <= now ? "expired" : "active";
}

async function runPairingList(json: boolean): Promise<number> {
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
  }

  for (const challenge of challenges) {
    const liveness = listLiveness(challenge, now);
    console.log(
      `${challenge.id}  ${challenge.userCode}  ${challenge.status}  ` +
        `${liveness}  minted ${new Date(challenge.createdAtMs).toISOString()}  ` +
        `expires ${new Date(challenge.expiresAtMs).toISOString()}`,
    );
    const userAgent = challenge.requesterUserAgent
      ? `  ${challenge.requesterUserAgent}`
      : "";
    console.log(
      `  ${challenge.verificationUri}  requester ${challenge.requesterIp}${userAgent}`,
    );
  }

  // The device-bound mint (the guardian lease's door) creates no pairing
  // challenge — it mints an actor token directly. Surface those leases here
  // too, so a mint that just succeeded is visible from this command.
  const leases = await listLocalDeviceLeases().catch(() => []);
  if (leases.length > 0) {
    console.log("");
    console.log("Device-bound leases:");
    for (const lease of leases) {
      console.log(
        `  ${lease.hashedDeviceId}  ${lease.platform}  ${
          lease.clientReportedName ?? "(unnamed)"
        }  issued ${new Date(lease.issuedAt).toISOString()}`,
      );
    }
  }

  return 0;
}

/**
 * The guardian's active device-bound leases, via the same handler the
 * `gateway devices list` command renders. Best-effort context for the list
 * view; an empty array on failure keeps the challenge listing working.
 */
async function listLocalDeviceLeases() {
  try {
    const { handleListDevices } = await import("../http/routes/devices.js");
    return await handleListDevices();
  } catch {
    return [];
  }
}

/**
 * Approve a pending pairing challenge by id — the same in-process store
 * write the old loopback approval routes did, minus the HTTP surface:
 * process execution is the local-presence proof, so no loopback-peer check
 * applies.
 */
function runPairingApprove(requestId: string): number {
  const result = approveRemoteWebPairingChallengeById(requestId);
  if (result.status === "invalid") {
    console.error(`Error: unknown pairing request '${requestId}'.`);
    return 1;
  }
  if (result.status === "expired") {
    console.error(`Error: pairing request '${requestId}' expired.`);
    return 1;
  }
  console.log(JSON.stringify(result));
  return 0;
}

function runPairingDeny(requestId: string): number {
  const result = denyRemoteWebPairingChallengeById(requestId);
  if (result.status === "invalid") {
    console.error(`Error: unknown pairing request '${requestId}'.`);
    return 1;
  }
  if (result.status === "already_approved") {
    console.error(
      `Error: pairing request '${requestId}' was already approved on another surface.`,
    );
    return 1;
  }
  console.log(`Pairing request ${requestId} denied.`);
  return 0;
}

export async function runPairingCommand(args: string[]): Promise<number> {
  const { subcommand } = parsePairingArgs(args);

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printUsage();
    return subcommand ? 0 : 1;
  }
  if (subcommand === "list") {
    return await runPairingList(args.includes("--json"));
  }
  if (subcommand === "approve" || subcommand === "deny") {
    const requestId = parsePairingArgs(args).positional;
    if (!requestId) {
      console.error(
        `Error: ${subcommand} needs a request id (see 'gateway pairing list').`,
      );
      return 1;
    }
    return subcommand === "approve"
      ? runPairingApprove(requestId)
      : runPairingDeny(requestId);
  }
  if (subcommand !== "mint") {
    console.error(`Error: unknown pairing subcommand '${subcommand}'.`);
    printUsage();
    return 1;
  }

  const mintArgv = args.slice(1);
  if (mintArgv.includes("--help") || mintArgv.includes("-h")) {
    printUsage();
    return 0;
  }

  // The device-bound arm — the guardian lease's door. The credential mints
  // directly in this process (process execution is the presence proof); a
  // self-exchange renders no link, so no saved ingress url is needed.
  const mintFlags = parsePairingMintArgs(mintArgv);
  if (mintFlags.deviceId) {
    try {
      const payload = await mintPairingPayload({
        deviceId: mintFlags.deviceId,
        platform: mintFlags.platform,
        clientReportedName: mintFlags.clientReportedName,
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

  const publicBaseUrl = readSavedIngressPublicBaseUrl();

  try {
    const challenge = mintAndApproveRemoteWebPairingChallenge(publicBaseUrl);
    console.log(JSON.stringify(challenge));
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: pairing mint failed: ${message}`);
    return 1;
  }
}
