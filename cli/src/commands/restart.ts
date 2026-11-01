import { sleep } from "./sleep.js";
import { cliCommandName } from "@mycadet/local-mode";
import { wake } from "./wake.js";

export const restart = Object.assign(
  async function restart(): Promise<void> {
    const args = process.argv.slice(3);
    if (args.includes("--help") || args.includes("-h")) {
      console.log(
        `Usage: ${cliCommandName()} restart [<name> | --all] [--force] [--wait [<duration>]] [--repair-guardian]`,
      );
      console.log("");
      console.log("Sleep, then wake the assistant.");
      console.log("");
      console.log(
        "Arguments and flags pass through to `cadet sleep` and `cadet wake`.",
      );
      console.log(
        "  --repair-guardian  Re-provision the guardian token during the wake",
      );
      process.exit(0);
    }
    if (args.includes("--all") && args.includes("--repair-guardian")) {
      console.error("Error: --all cannot be combined with --repair-guardian.");
      process.exit(1);
    }
    await sleep();
    await wake();
  },
  { description: "Sleep, then wake the assistant" },
);
