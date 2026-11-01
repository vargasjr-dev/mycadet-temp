/**
 * `cadet devices [name]` and `cadet devices revoke <hashedDeviceId> [name] [--yes]`
 *
 * Host-side of pairing lifecycle: list and revoke the devices paired to a LOCAL
 * self-hosted assistant. Calls the loopback-only gateway endpoints
 * `GET /v1/devices` and `POST /v1/devices/revoke` (added in the gateway slice),
 * which self-guard loopback + reject any browser/WebView Origin. The gateway
 * only ever stores the HASHED device id, so list returns and revoke accepts the
 * same `hashedDeviceId` (the raw device id is never persisted anywhere).
 */

import { z } from "zod";
import { getGatewayUrl } from "@mycadet/local-mode/contract";
import { createHash } from "node:crypto";
import { hostname } from "node:os";

import {
  DeviceRecord,
  getAssistantDisplayName,
  loopbackSafeFetch,
} from "@mycadet/local-mode";

import { type LockfileAssistant } from "@mycadet/local-mode/contract";
import { resolveTargetAssistant } from "../lib/assistant-config";
import type { GuardianTokenData } from "@mycadet/local-mode";
import { computeDeviceId, loadGuardianToken } from "../lib/guardian-token.js";
import { parseAssistantTargetArg } from "../lib/assistant-target-args.js";
import {
  CLI_INTERFACE_ID,
  getClientRegistrationHeaders,
} from "../lib/client-identity.js";
import {
  canPromptForConfirmation,
  confirmAction,
} from "../lib/confirm-action.js";
import { GATEWAY_INTERNAL_PORT } from "../lib/environments/paths.js";
import { execOutput } from "../lib/step-runner.js";
import { dockerResourceNames } from "@mycadet/local-mode";

const dockerGatewayResponseSchema = z.object({
  status: z.number().int().min(200).max(599),
  body: z.string(),
});

function printUsage(): void {
  console.log(`cadet devices - List and revoke devices paired to a local assistant

USAGE:
    cadet devices [name]
    cadet devices revoke <hashedDeviceId> [name] [--yes]

ARGUMENTS:
    [name]              Name or id of the local assistant (defaults to the active/sole one)
    <hashedDeviceId>    The device's hashed id (copy it from the list output)

OPTIONS:
    --yes              Skip the interactive confirmation prompt when revoking (for automation)
    --json             Print machine-readable JSON on stdout (revoke requires --yes)

Lists the devices paired to a local (host-side) assistant, or revokes one by its
hashed id. Runs on the machine that hosts the assistant.

EXAMPLES:
    cadet devices
    cadet devices my-desk
    cadet devices revoke 3f9a1c...
    cadet devices revoke 3f9a1c... my-desk --yes
`);
}

/**
 * Resolve the LOOPBACK gateway base URL for a host-side assistant, or exit with
 * a helpful error. Never falls back to a non-loopback URL.
 */
function resolveLoopbackBase(entry: LockfileAssistant): string {
  const displayName = getAssistantDisplayName(entry);

  if (entry.cloud === "docker")
    return `http://127.0.0.1:${GATEWAY_INTERNAL_PORT}`;

  const base = getGatewayUrl(entry);
  if (
    !base.startsWith("http://127.0.0.1:") &&
    !base.startsWith("http://localhost:")
  ) {
    console.error(
      `Error: no local gateway found for '${displayName}'. \`cadet devices\` runs on the machine hosting the assistant.`,
    );
    process.exit(1);
  }

  return base;
}

/** Docker host management enters the gateway network namespace before calling loopback-only routes. */
async function deviceRequest(
  entry: LockfileAssistant,
  url: string,
  init: RequestInit,
): Promise<Response> {
  if (entry.cloud !== "docker") return loopbackSafeFetch(url, init);
  const script = `const r = await fetch(process.argv[1], {...JSON.parse(process.argv[2]), signal: AbortSignal.timeout(10000)}); console.log(JSON.stringify({status:r.status, body:await r.text()}));`;
  const output = await execOutput(
    "docker",
    [
      "exec",
      dockerResourceNames(entry.assistantId).gatewayContainer,
      "bun",
      "-e",
      script,
      url,
      JSON.stringify(init),
    ],
    { timeoutMs: 15000 },
  );
  const result = dockerGatewayResponseSchema.parse(JSON.parse(output));
  return new Response(result.body, { status: result.status });
}

/**
 * The hashed device id the gateway stores for THIS machine's own guardian
 * credential (`leaseGuardianToken` registers it device-bound as
 * sha256(deviceId)). The gateway's row hashes the deviceId the token was
 * leased with, so prefer the stored token's deviceId and fall back to the
 * current machine id for tokens persisted before the field was stored. It
 * shows up in `/v1/devices` next to remotely paired devices; revoking it
 * locks this host out of its own assistant until guardian repair.
 */
function currentHostHashedDeviceId(token?: GuardianTokenData | null): string {
  const deviceId = token?.deviceId || computeDeviceId();
  return createHash("sha256").update(deviceId).digest("hex");
}

/**
 * The local guardian token.json IS a paired device even when the gateway has
 * no record of it (fresh gateway DB, a lease that predates device tracking).
 * Rebuild the row it would have — same identity the gateway would have
 * stored — so it always shows up in `cadet devices` and stays revocable.
 */
function localHostDeviceRow(
  token: GuardianTokenData,
  hashedDeviceId: string,
): DeviceRecord {
  const leasedAtMs = Date.parse(token.leasedAt);
  return {
    hashedDeviceId,
    platform: "cli",
    issuedAt: Number.isFinite(leasedAtMs) ? leasedAtMs : null,
    expiresAt: null,
    lastUsedAt: null,
    pairingUserAgent: null,
    clientReportedName: hostname(),
    isCurrentHost: true,
  };
}

/** Format an epoch-ms timestamp as ISO, or a placeholder when absent. */
function formatTimestamp(ms: number | null, absent: string): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return absent;
  return new Date(ms).toISOString();
}

async function listDevices(
  entry: LockfileAssistant,
  base: string,
  jsonOutput: boolean,
): Promise<void> {
  const displayName = getAssistantDisplayName(entry);

  let response: Response;
  try {
    response = await deviceRequest(entry, `${base}/v1/devices`, {
      method: "GET",
      headers: getClientRegistrationHeaders(CLI_INTERFACE_ID),
    });
  } catch (err) {
    console.error(
      `Error: could not reach the gateway for '${displayName}' at ${base}: ${
        (err as Error).message
      }`,
    );
    process.exit(1);
  }

  if (!response.ok) {
    console.error(
      `Error: gateway returned ${response.status} listing devices for '${displayName}'.`,
    );
    process.exit(1);
  }

  const body = (await response.json()) as { devices?: DeviceRecord[] };
  const token = loadGuardianToken(entry.assistantId);
  const hostHash = currentHostHashedDeviceId(token);
  const devices = (body.devices ?? []).map((device) =>
    device.hashedDeviceId === hostHash
      ? { ...device, isCurrentHost: true as const }
      : device,
  );

  // The local guardian token.json IS a paired device even when the gateway
  // has no record of it (fresh gateway DB, lease predating device tracking):
  // synthesize the row it would have so it stays visible and revocable here.
  if (token && !devices.some((device) => device.hashedDeviceId === hostHash)) {
    devices.push(localHostDeviceRow(token, hostHash));
  }

  if (jsonOutput) {
    console.log(JSON.stringify({ devices }));
    return;
  }

  if (devices.length === 0) {
    console.log(`No devices are paired to ${displayName}.`);
    return;
  }

  console.log(`Devices paired to ${getAssistantDisplayName(entry)}:`);
  console.log("");
  for (const device of devices) {
    console.log(`  ${device.hashedDeviceId}`);
    console.log(`    platform:   ${device.platform}`);
    console.log(
      `    name:       ${device.clientReportedName || "not reported"}`,
    );
    console.log(`    user agent: ${device.pairingUserAgent || "not recorded"}`);
    console.log(`    issued:     ${formatTimestamp(device.issuedAt, "—")}`);
    console.log(`    expires:    ${formatTimestamp(device.expiresAt, "—")}`);
    console.log(
      `    last used:  ${formatTimestamp(device.lastUsedAt, "never")}`,
    );
    if (device.isCurrentHost) {
      console.log(
        "    this machine's host credential; revoking locks this host out until guardian repair",
      );
    }
    console.log("");
  }
  console.log(
    `${devices.length} device(s). Revoke one with: cadet devices revoke <hashedDeviceId>`,
  );
}

async function revokeDevice(
  entry: LockfileAssistant,
  base: string,
  hashedDeviceId: string,
  yes: boolean,
  jsonOutput: boolean,
): Promise<void> {
  const displayName = getAssistantDisplayName(entry);

  if (jsonOutput && !yes) {
    console.error(
      "Error: --json requires --yes; the revoke confirmation prompt would corrupt JSON stdout.",
    );
    process.exit(1);
  }

  // Print the resolved identity before acting (cli/AGENTS.md). In --json mode
  // it goes to stderr so stdout stays a single JSON document.
  const printIdentity = jsonOutput ? console.error : console.log;
  printIdentity("Device to revoke:");
  printIdentity(`  Assistant: ${getAssistantDisplayName(entry)}`);
  printIdentity(`  Device:    ${hashedDeviceId}`);
  printIdentity("");

  // Warn (don't block; recoverable via guardian repair) when the target is
  // this machine's own host credential. --json is app-driven; the UI disables
  // the host row, so the warning stays out of automation transcripts.
  const localToken = loadGuardianToken(entry.assistantId);
  if (!jsonOutput && hashedDeviceId === currentHostHashedDeviceId(localToken)) {
    console.error(
      "Warning: this is this machine's own host credential. Revoking it locks this host out of the assistant until guardian repair.",
    );
    console.error("");
  }

  if (!yes) {
    if (!canPromptForConfirmation()) {
      console.error(
        "Error: Refusing to revoke without confirmation in a non-interactive terminal.",
      );
      console.error("Re-run with --yes to confirm from automation.");
      process.exit(1);
    }
    const confirmed = await confirmAction(
      "Press Enter to revoke, or Esc/q to cancel: ",
    );
    if (!confirmed) {
      console.log("Revoke cancelled.");
      process.exit(1);
    }
  }

  let response: Response;
  try {
    response = await deviceRequest(entry, `${base}/v1/devices/revoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...getClientRegistrationHeaders(CLI_INTERFACE_ID),
      },
      body: JSON.stringify({ hashedDeviceId }),
    });
  } catch (err) {
    console.error(
      `Error: could not reach the gateway for '${displayName}' at ${base}: ${
        (err as Error).message
      }`,
    );
    process.exit(1);
  }

  if (!response.ok) {
    console.error(
      `Error: gateway returned ${response.status} revoking device for '${displayName}'.`,
    );
    process.exit(1);
  }

  if (jsonOutput) {
    console.log(
      JSON.stringify({
        ok: true,
        hashedDeviceId,
        assistantId: entry.assistantId,
      }),
    );
    return;
  }

  console.log(
    `Revoked device ${hashedDeviceId} from ${displayName}. Its tokens are invalidated; that machine must re-pair to reconnect.`,
  );
}

export const devices = Object.assign(
  async function devices(): Promise<void> {
    const rawArgs = process.argv.slice(3);

    if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
      printUsage();
      return;
    }

    const jsonOutput = rawArgs.includes("--json");
    const args = rawArgs.filter((a) => a !== "--json");

    if (args[0] === "revoke") {
      const rest = args.slice(1);
      const yes = rest.includes("--yes");
      const positionals = rest.filter((a) => !a.startsWith("-"));
      const hashedDeviceId = positionals[0];
      if (!hashedDeviceId) {
        console.error("Error: a hashedDeviceId is required to revoke.");
        printUsage();
        process.exit(1);
      }
      const nameArg = positionals.slice(1).join(" ") || undefined;
      const entry = resolveTargetAssistant(nameArg);
      const base = resolveLoopbackBase(entry);
      await revokeDevice(entry, base, hashedDeviceId, yes, jsonOutput);
      return;
    }

    const nameArg = parseAssistantTargetArg(args, []);
    const entry = resolveTargetAssistant(nameArg);
    const base = resolveLoopbackBase(entry);
    await listDevices(entry, base, jsonOutput);
  },
  { description: "List or revoke devices paired to a local assistant" },
);
