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
import {
  loadOrCreateSigningKey,
  initSigningKey,
} from "../auth/token-service.js";

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

// Every served command reads or mints gateway-owned state through
// getGatewayDb(), whose singleton only exists after initGatewayDb(). The
// HTTP server's main() awaits this same call before its listener binds —
// the CLI is the second entry into the same module graph, and without it
// every invocation died on "Gateway DB not initialized" (the hatch's
// guardian-token lease, which runs `gateway pairing mint` as its
// local-presence proof, burned all three of its retries on this).
await initGatewayDb();

// Minted credentials are signed with the same key the server loads at
// startup — a mint that skipped it died one error later on "Auth signing
// key not initialized".
initSigningKey(loadOrCreateSigningKey());

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
