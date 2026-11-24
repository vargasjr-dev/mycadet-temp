/**
 * The `gateway` operator CLI's commander program — one place where the
 * command tree, flags, and help live, so the parse bugs hand-rolled argv
 * bred (#881's help-exits-1 class) are the library's problem, not ours.
 *
 * Each action adapts commander's parsed options into the typed command
 * shapes the execute layer already speaks, and exits with the layer's
 * code. Machine-readable contracts (single-line JSON on stdout, exit
 * codes) are unchanged from the hand-rolled CLI.
 */

import { Command } from "commander";
import { APP_VERSION } from "../version.js";

import {
  handleListDevices,
  handleRevokeDevice,
} from "../http/routes/devices.js";
import {
  defaultGatewayIpcCall,
  executeContactsCommand,
  type GatewayIpcCall,
  type ParsedContactsCommand,
} from "./contacts.js";
import {
  runPairingApprove,
  runPairingDeny,
  runPairingList,
  runPairingMint,
} from "./pairing.js";

const THRESHOLD_BY_VALUE: Record<
  string,
  "none" | "low" | "medium" | "high" | "inherit" | undefined
> = {
  none: "none",
  low: "low",
  medium: "medium",
  high: "high",
  inherit: "inherit",
};

export function buildGatewayCliProgram(
  ipc: GatewayIpcCall = defaultGatewayIpcCall,
): Command {
  const program = new Command();
  program
    .name("gateway")
    .version(APP_VERSION)
    .description("Operator commands for gateway-owned state.");

  // ── contacts ────────────────────────────────────────────────────
  const contacts = program
    .command("contacts")
    .description("Manage the contact ACL with list, get, set-risk-threshold");

  contacts
    .command("list")
    .description("List contacts")
    .option("--role <role>", "Filter list by contact or guardian")
    .option("--json", "Machine-readable JSON")
    .action(async (opts: { role?: string; json?: boolean }) => {
      const parsed: ParsedContactsCommand = {
        kind: "list",
        json: opts.json ?? false,
        ...(opts.role ? { role: opts.role } : {}),
      };
      process.exit(await executeContactsCommand(parsed, ipc));
    });

  contacts
    .command("get <contactId>")
    .description("Get one contact")
    .option("--json", "Machine-readable JSON")
    .action(async (contactId: string, opts: { json?: boolean }) => {
      const parsed: ParsedContactsCommand = {
        kind: "get",
        contactId,
        json: opts.json ?? false,
      };
      process.exit(await executeContactsCommand(parsed, ipc));
    });

  contacts
    .command("set-risk-threshold <contactId>")
    .description("Set the contact risk ceiling")
    .option("--json", "Machine-readable JSON")
    .requiredOption(
      "--threshold <value>",
      "none, low, medium, high, or inherit",
    )
    .action(
      async (
        contactId: string,
        opts: { threshold: string; json?: boolean },
      ) => {
        const threshold = THRESHOLD_BY_VALUE[opts.threshold];
        if (threshold === undefined) {
          console.error(
            `Invalid --threshold "${opts.threshold}". Must be one of: none, low, medium, high, inherit.`,
          );
          process.exit(1);
        }
        const parsed: ParsedContactsCommand = {
          kind: "set-risk-threshold",
          contactId,
          threshold: threshold === "inherit" ? null : threshold,
          json: opts.json ?? false,
        };
        process.exit(await executeContactsCommand(parsed, ipc));
      },
    );

  // ── devices ─────────────────────────────────────────────────────
  const devices = program
    .command("devices")
    .description("Operator commands for gateway-owned device management");

  devices
    .command("list")
    .description("List devices")
    .action(async () => {
      const list = await handleListDevices();
      if (list.length === 0) {
        console.log("No devices found.");
        process.exit(0);
      }
      // Hashed device ids vary in length — pad every column (header
      // included) to its widest value so the rows stay aligned.
      const idWidth = Math.max(
        "DEVICE ID".length,
        ...list.map((d) => d.hashedDeviceId.length),
      );
      const platformWidth = Math.max(
        "PLATFORM".length,
        ...list.map((d) => d.platform.length),
      );
      console.log(
        `DEVICE ID${" ".repeat(idWidth - "DEVICE ID".length)}  PLATFORM${" ".repeat(platformWidth - "PLATFORM".length)}  NAME`,
      );
      for (const device of list) {
        console.log(
          `${device.hashedDeviceId.padEnd(idWidth)}  ${device.platform.padEnd(platformWidth)}  ${device.clientReportedName}`,
        );
      }
      console.log("");
      console.log(`${list.length} ${list.length === 1 ? "device" : "devices"}`);
      process.exit(0);
    });

  devices
    .command("revoke <deviceId>")
    .description("Revoke a device")
    .action(async (deviceId: string) => {
      const result = await handleRevokeDevice(deviceId);
      if (result.revoked) {
        console.log(`Device ${deviceId} revoked.`);
        process.exit(0);
      }
      console.error(`Failed to revoke device ${deviceId}`);
      process.exit(0);
    });

  // ── pairing ─────────────────────────────────────────────────────
  const pairing = program
    .command("pairing")
    .description(
      "Pairing challenges (mint [--device-id <id>] | list [--json])",
    );

  pairing
    .command("mint")
    .description(
      "Mint and approve a pairing challenge, or — with --device-id — the device-bound guardian credential",
    )
    // The challenge flow takes no options, and the hand-rolled CLI
    // deliberately let a typo'd flag degrade to the plain mint rather than
    // error a lease that never passed it — keep the leniency.
    .allowUnknownOption()
    .option("--device-id <id>", "Mint the device-bound guardian credential")
    .option("--platform <p>", "The pairing platform (device-bound mint)")
    .option(
      "--client-reported-name <n>",
      "The device's self-reported name (device-bound mint)",
    )
    .action(
      async (opts: {
        deviceId?: string;
        platform?: string;
        clientReportedName?: string;
      }) => {
        process.exit(
          await runPairingMint({
            deviceId: opts.deviceId ?? null,
            platform: opts.platform ?? "cli",
            ...(opts.clientReportedName
              ? { clientReportedName: opts.clientReportedName }
              : {}),
          }),
        );
      },
    );

  pairing
    .command("list")
    .description("List every persisted pairing challenge — active and expired")
    .option("--json", "Machine-readable JSON")
    .action(async (opts: { json?: boolean }) => {
      process.exit(await runPairingList(opts.json ?? false));
    });

  pairing
    .command("approve <requestId>")
    .description("Approve a pending pairing request minted elsewhere")
    .action(async (requestId: string) => {
      process.exit(runPairingApprove(requestId));
    });

  pairing
    .command("deny <requestId>")
    .description("Deny (delete) a pending pairing request by id")
    .action(async (requestId: string) => {
      process.exit(runPairingDeny(requestId));
    });

  return program;
}
