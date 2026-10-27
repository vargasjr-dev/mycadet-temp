import { connectImport } from "./connect/import.js";
import { cliCommand } from "../lib/cli-name.js";

function printUsage(): void {
  console.log(`Usage: ${cliCommand()} connect [beta] <subcommand>`);
  console.log("");
  console.log("Connect to an assistant paired from another machine.");
  console.log("");
  console.log("Subcommands:");
  console.log(
    "  import    Pair with an assistant at a link or https address and register it",
  );
}

export const connect = Object.assign(
  async function connect(): Promise<void> {
    const args = process.argv.slice(3);
    const subcommand = args[0];

    if (subcommand === "--help" || subcommand === "-h" || !subcommand) {
      printUsage();
      process.exit(0);
    }

    if (subcommand === "import") {
      await connectImport();
      return;
    }

    console.error(`Unknown subcommand: ${subcommand}`);
    printUsage();
    process.exit(1);
  },
  { description: "Pair with an assistant running on another machine [beta]" },
);
