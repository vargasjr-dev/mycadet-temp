/**
 * `cadet pair [assistant] [options]`
 *
 * Print the pairing link for another device, and the same link rendered as a
 * QR code. Runs on the machine hosting the assistant: it mints a remote-web
 * pairing challenge through the gateway CLI (`gateway pairing mint` —
 * locally, or docker-exec'd into the gateway container) which approves it
 * immediately, so running this command IS the local-presence proof and one
 * scan (or one paste into `cadet connect import`) completes the pairing.
 * local and docker assistants mint without any HTTP; other topologies keep
 * the loopback HTTP mint.
 *
 * `--web-approve` is the reverse direction: approve a code a device already
 * shows, for pairings that device started on its own.
 */

// Call `qrcodeTerminal.generate` as a method — the library reads its default
// error-correction level off `this`, so a destructured import renders nothing.
import qrcodeTerminal from "qrcode-terminal";
import {
  getGatewayUrl,
  isAppleContainerEntry,
  isDockerEntry,
  isLocalEntry,
} from "@mycadet/local-mode/contract";

import {
  buildRemoteWebPairingUrl,
  type RemoteWebPairingChallengeResponse,
  type RemoteWebPairingVerificationRequest,
  type RemoteWebPairingVerificationResponse,
} from "@mycadet/service-contracts/remote-web-pairing";

import { extractFlag } from "../lib/arg-utils.js";
import { parseAssistantTargetArg } from "../lib/assistant-target-args.js";
import { type LockfileAssistant } from "@mycadet/local-mode/contract";
import {
  formatAssistantLookupError,
  getAssistantDisplayName,
  lookupAssistantByIdentifier,
  resolveAssistant,
} from "../lib/assistant-config.js";
import { getCurrentEnvironment } from "../lib/environments/resolve.js";
import { loopbackSafeFetch } from "../lib/loopback-fetch.js";
import { dockerPair } from "../lib/remotes/docker.js";
import { appleContainerPair } from "../lib/remotes/apple-container.js";
import { localPair } from "../lib/remotes/local.js";
import { cloudPair } from "../lib/remotes/cloud.js";
import { formatWebApproveFailure, parseGatewayErrorCode } from "../lib/pair.js";
import { STALE_CLI_UPDATE_HINT } from "../lib/stale-cli-hint.js";

function assistantDisplayName(entry: LockfileAssistant): string {
  return entry.name || entry.assistantId;
}

function printUsage(): void {
  console.log(`cadet pair - Print a pairing link and QR code for another device

USAGE:
    cadet pair [assistant] [options]

Mints a pairing challenge on the assistant's gateway (via the gateway CLI
for local and docker assistants, over loopback HTTP otherwise) and approves
it on the spot (running this command on the host machine is the approval),
then prints the pairing link and the same link as a QR code.
Scanning the QR, opening the link, or passing it to 'cadet connect import'
on the other device completes the pairing in one step.

The link needs a public https address: the one 'cadet tunnel start' recorded
for this assistant. Run 'cadet tunnel start' first if none is saved yet.
Loopback, private-network, plain-http, and tunnel-provider website addresses
are refused before anything is minted.

The challenge lives on the assistant's gateway and expires (10 minutes); the
link carries only a one-time device code, no tokens. Each paired device is
listed and separately revocable via 'cadet devices'.

ARGUMENTS:
    [assistant]     Assistant display name or ID (default: the active assistant)

OPTIONS:
    --label <name>  Name for this pairing. Shown in the output, and used as the
                    assistant's name in the --app link.
    --app           Encode the QR as a <scheme>://connect link that opens the
                    Cadet app directly. The https link is still printed as a
                    fallback for devices without the app.
    --app-scheme <scheme>
                    URL scheme for --app links; requires --app (default:
                    cadet; dev and staging app builds register
                    cadet-dev and cadet-staging).
    --web-approve <code>
                    Approve a pairing code another device is showing, in
                    ABCD-EFGH form, e.g. from 'cadet connect import <url>' or
                    the /assistant/pair page. Mints no link of its own.
    --json          Print JSON instead of the QR code:
                    {pairUrl, deviceCode, expiresAt, expiresInSeconds}, plus
                    appUrl with --app. With --web-approve, the approval
                    response: {status, verificationUri, expiresAt}.

EXAMPLES:
    cadet pair
    cadet pair --app --label "Phone"
    cadet pair --web-approve ABCD-EFGH
`);
}

/** Default URL scheme registered by production builds of the iOS app. */
const DEFAULT_APP_CONNECT_SCHEME = "cadet";

/**
 * Compose the custom-scheme link the iOS app's connect handler accepts:
 * `<scheme>://connect?url=<base>&code=<device code>[&name=<label>]`. The app
 * persists the base (and the label, when present) as its self-hosted server
 * and opens the pair page with the code.
 */
export function buildAppConnectUrl(
  scheme: string,
  baseUrl: string,
  deviceCode: string,
  name?: string,
): string {
  const params = new URLSearchParams({ url: baseUrl, code: deviceCode });
  if (name) {
    params.set("name", name);
  }
  // Percent-encode spaces: URLSearchParams form-encodes them as `+`, which
  // the app's Foundation URLComponents parser keeps as a literal plus.
  const query = params.toString().replace(/\+/g, "%20");
  return `${scheme}://connect?${query}`;
}

/**
 * POST a JSON body to a loopback gateway route, exiting with a clear message
 * when the gateway is unreachable. Non-2xx responses are returned to the
 * caller; use {@link gatewayPostOrExit} unless the call site prints its own
 * HTTP-error diagnostics.
 */
async function gatewayPost(
  gatewayUrl: string,
  path: string,
  body: unknown,
): Promise<Response> {
  try {
    return await loopbackSafeFetch(`${gatewayUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error(
      `Error: could not reach the gateway at ${gatewayUrl} ` +
        `(${err instanceof Error ? err.message : String(err)}).`,
    );
    console.error("Is the assistant running? Try `cadet wake`.");
    process.exit(1);
  }
}

/**
 * Mint (and approve) a remote-web pairing challenge. `cadet pair` is a
 * wrapper around `gateway pairing mint` executed on the assistant's gateway:
 * each topology's own remote module owns its execution surface
 * (`localPair` through the gateway CLI invocation, `dockerPair` through
 * docker exec, `appleContainerPair` through the management socket,
 * `cloudPair` through the platform's terminal-session exec). Process
 * execution is the local-presence proof; the mint approves on the spot, so
 * the returned challenge is already paired-ready.
 */
async function mintPairingChallengeOrExit(
  entry: LockfileAssistant,
): Promise<RemoteWebPairingChallengeResponse> {
  let stdout: string;
  try {
    if (isLocalEntry(entry)) {
      stdout = await localPair(entry);
    } else if (isDockerEntry(entry)) {
      stdout = await dockerPair(entry);
    } else if (isAppleContainerEntry(entry)) {
      stdout = await appleContainerPair(entry);
    } else {
      stdout = await cloudPair(entry);
    }
  } catch (err) {
    console.error(
      `Error: could not mint a pairing challenge on the gateway ` +
        `(${err instanceof Error ? err.message : String(err)}).`,
    );
    console.error("Is the assistant running? Try `cadet wake`.");
    process.exit(1);
  }

  return parseMintedChallenge(stdout);
}

/** Parse the mint's last stdout line into the challenge response. */
function parseMintedChallenge(
  stdout: string,
): RemoteWebPairingChallengeResponse {
  const lastLine = stdout.split("\n").filter(Boolean).pop() ?? "";
  let challenge: RemoteWebPairingChallengeResponse;
  try {
    challenge = JSON.parse(lastLine) as RemoteWebPairingChallengeResponse;
  } catch {
    console.error("Error: could not parse the gateway's pairing mint output.");
    process.exit(1);
  }
  if (!challenge.deviceCode || !challenge.userCode) {
    console.error(
      "Error: the gateway's pairing mint output is missing the challenge codes.",
    );
    process.exit(1);
  }
  return challenge;
}

/**
 * Approve a pending pairing challenge by its user code, the local-presence
 * proof for the device-code flow. Single owner of the pairing-verification
 * route and request body: `--web-approve` calls this directly to inspect
 * rejections and print mismatch diagnostics (see
 * {@link formatWebApproveFailure}); the link flow needs no separate
 * verification call — the gateway-CLI mint approves on the spot.
 */
async function postPairingVerification(
  gatewayUrl: string,
  userCode: string,
): Promise<Response> {
  return gatewayPost(gatewayUrl, "/v1/remote-web/pairing-verification", {
    userCode,
  } satisfies RemoteWebPairingVerificationRequest);
}

export const pair = Object.assign(
  async function pair(): Promise<void> {
    const rawArgs = process.argv.slice(3);

    if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
      printUsage();
      return;
    }

    const jsonOutput = rawArgs.includes("--json");
    const webApproval = rawArgs.includes("--web-approve");
    const appVariant = rawArgs.includes("--app");
    // `--qr` is accepted and ignored: QR output is unconditional, and iOS
    // Settings copy in the field names `cadet pair --qr`. Out of --help as a
    // compatibility shim, not part of the command's surface.
    let args = rawArgs.filter(
      (a) => a !== "--json" && a !== "--app" && a !== "--qr",
    );

    const [label, afterLabel] = extractFlag(args, "--label");
    const [webApproveCode, afterWebApprove] = extractFlag(
      afterLabel,
      "--web-approve",
    );
    const [appSchemeOverride, afterAppScheme] = extractFlag(
      afterWebApprove,
      "--app-scheme",
    );
    args = afterAppScheme;

    // Any `--`-prefixed token left after known-flag extraction is an option this
    // CLI version doesn't support. Fail loud before any network call rather than
    // letting it fall through: an unknown flag would otherwise be silently
    // dropped and the command would run the wrong flow. Positional names never
    // start with `--`, so multi-word assistant targets are unaffected.
    const unknownFlag = args.find((a) => a.startsWith("--"));
    if (unknownFlag) {
      console.error(`Error: unknown option '${unknownFlag}'.`);
      console.error("Run `cadet pair --help` to see available options.");
      console.error(
        `If this option is from newer docs, ${STALE_CLI_UPDATE_HINT}`,
      );
      process.exit(1);
    }

    if (webApproval && !webApproveCode) {
      console.error("Error: --web-approve requires a pairing code.");
      process.exit(1);
    }
    if ((appVariant || appSchemeOverride) && webApproveCode) {
      console.error(
        "Error: --app and --app-scheme don't apply to --web-approve, which " +
          "approves a code the other device already has.",
      );
      process.exit(1);
    }
    // A scheme only names the app link, so accepting it without --app would
    // print the https QR and drop the scheme without saying so.
    if (appSchemeOverride && !appVariant) {
      console.error(
        "Error: --app-scheme names the scheme for the app link, so it needs " +
          "--app. Re-run with both, or drop --app-scheme for the https link.",
      );
      process.exit(1);
    }

    // Resolve the target. An explicit argument is matched by display name OR id
    // (with the standard ambiguity error); no argument falls back to the active
    // assistant. Join positional tokens so multi-word display names work even
    // unquoted (e.g. `cadet pair My Assistant`).
    const assistantName = parseAssistantTargetArg(args);
    let entry: LockfileAssistant | null;
    if (assistantName) {
      const result = lookupAssistantByIdentifier(assistantName);
      if (result.status !== "found") {
        console.error(formatAssistantLookupError(assistantName, result));
        process.exit(1);
      }
      entry = result.entry;
    } else {
      entry = resolveAssistant();
      if (!entry) {
        console.error("No assistant instance found. Run `cadet hatch` first.");
        process.exit(1);
      }
    }

    // Minting requires host presence on this machine. Native and docker
    // topologies qualify (the latter via docker exec); an assistant this
    // machine only knows through `connect import` has no host presence here
    // at all, and its mint fails on the loopback gate below.

    // Mint over loopback (the derived port avoids mDNS for same-machine calls),
    // but advertise a REACHABLE url in the link, since the loopback url would
    // point the other device at its own localhost: the public https address
    // `cadet tunnel start` recorded for this assistant.
    const mintUrl = getGatewayUrl(entry);

    if (webApproveCode) {
      // Rejections are diagnosed here rather than by exitOnHttpError: a
      // rejected code must name the gateway that was asked, or an
      // assistant/environment mismatch is indistinguishable from a typo.
      const response = await postPairingVerification(mintUrl, webApproveCode);
      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        const diagnostic = formatWebApproveFailure(
          mintUrl,
          getAssistantDisplayName(entry),
          getCurrentEnvironment().name,
          parseGatewayErrorCode(errorBody),
        );
        console.error(
          diagnostic ??
            `Error: HTTP ${response.status}: ${errorBody || response.statusText}`,
        );
        process.exit(1);
      }
      const result =
        (await response.json()) as RemoteWebPairingVerificationResponse;
      if (jsonOutput) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log("Remote web pairing approved.");
      console.log(`Expires: ${result.expiresAt}`);
      return;
    }

    // The gateway owns the advertised address: it self-sources the public URL
    // the tunnel recorded (and refuses honestly when none is), so this command
    // never reads the workspace's ingress state.
    const challenge = await mintPairingChallengeOrExit(entry);
    const pairUrl = buildRemoteWebPairingUrl(challenge);
    const displayName = assistantDisplayName(entry);
    const appUrl = appVariant
      ? buildAppConnectUrl(
          appSchemeOverride ?? DEFAULT_APP_CONNECT_SCHEME,
          challenge.publicBaseUrl,
          challenge.deviceCode,
          label || displayName,
        )
      : null;

    if (jsonOutput) {
      console.log(
        JSON.stringify(
          {
            pairUrl,
            ...(appUrl ? { appUrl } : {}),
            deviceCode: challenge.deviceCode,
            expiresAt: challenge.expiresAt,
            expiresInSeconds: challenge.expiresInSeconds,
          },
          null,
          2,
        ),
      );
      return;
    }

    console.log(
      label
        ? `Scan to pair "${label}" with ${displayName}:`
        : `Scan to pair a device with ${displayName}:`,
    );
    console.log("");
    qrcodeTerminal.generate(appUrl ?? pairUrl, { small: true }, (qr) => {
      console.log(qr);
    });
    console.log("");
    console.log("Or enter this code on the pairing page:");
    console.log("");
    console.log(`  ${challenge.deviceCode}`);
    console.log("");
    if (appUrl) {
      console.log("The QR opens the Cadet app. App link:");
      console.log("");
      console.log(`  ${appUrl}`);
      console.log("");
      console.log(
        "No app on the device? Open this URL in its browser instead:",
      );
    } else {
      console.log("Or open this URL on the device:");
    }
    console.log("");
    console.log(`  ${pairUrl}`);
    console.log("");
    console.log("Or on another computer, run:");
    console.log("");
    console.log(`  cadet connect import "${pairUrl}"`);
    console.log("");
    console.log(`Expires: ${challenge.expiresAt}`);
  },
  { description: "Print a pairing link and QR code for another device" },
);
