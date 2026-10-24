import { gatewayToken } from "./gateway/token.js";
import { key as gatewayKey } from "./gateway/key.js";
import { cliCommand } from "../lib/cli-name.js";

function printUsage(): void {
  console.log(`Usage: ${cliCommand()} gateway <subcommand>`);
  console.log("");
  console.log("Gateway management commands.");
  console.log("");
  console.log("Subcommands:");
  console.log("  token    Manage gateway authentication tokens");
  console.log("  key      Manage the gateway signing key");
}

export const gateway = Object.assign(
  async function gateway(): Promise<void> {
  const args = process.argv.slice(3);
  const subcommand = args[0];

  if (subcommand === "--help" || subcommand === "-h" || !subcommand) {
    printUsage();
    process.exit(0);
  }

  if (subcommand === "token") {
    await gatewayToken();
    return;
  }

  if (subcommand === "key") {
    await gatewayKey(args.slice(1));
    return;
  }

  console.error(`Unknown subcommand: ${subcommand}`);
  printUsage();
  process.exit(1);
},
  { description: "Gateway management commands" },
);

