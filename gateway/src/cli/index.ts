#!/usr/bin/env bun

/**
 * Operator CLI for gateway-owned state. Invoked as `gateway <command>`.
 *
 * This entry starts the CLI, not the gateway HTTP server. The server
 * remains `bun run src/index.ts`.
 */

import { runContactsCommand } from "./contacts.js";
import { runDevicesCommand } from "../http/routes/devices.js";
import { runPairingCommand } from "./pairing.js";
import { initGatewayDb } from "../db/connection.js";
import { initSigningKey } from "../auth/token-service.js";

// One-shot commands print machine-readable JSON on stdout; their callers
// parse it. Silence pino entirely (no pretty stdout, no log files) — the
// lazy proxy logger builds on the first log call, which happens inside the
// command bodies below, after this flag is set. Errors surface through
// console.error + exit codes instead.
process.env["GATEWAY_LOG_SILENT"] = "1";

function printUsage(): void {
  console.log("Usage: gateway <command>");
  console.log("");
  console.log("Operator commands for gateway-owned state.");
  console.log("");
  console.log("Commands:");
  console.log(
    "  contacts    Manage the contact ACL with list, get, set-risk-threshold",
  );
  console.log(
    "  pairing     Pairing challenges (mint [--device-id <id>] | list [--json])",
  );
}

const args = process.argv.slice(2);
const command = args[0];
const opts = args.slice(1);

if (command === "--help" || command === "-h" || !command) {
  printUsage();
  process.exit(0);
}

// Prepare DB for commands that depend on it below
await initGatewayDb({ migrate: false });

initSigningKey();

if (command === "contacts") {
  const code = await runContactsCommand(opts);
  process.exit(code);
}

if (command === "devices") {
  const code = await runDevicesCommand(opts);
  process.exit(code);
}

if (command === "pairing") {
  const code = await runPairingCommand(opts);
  process.exit(code);
}

console.error(`Unknown command: ${command}`);
printUsage();
process.exit(1);
