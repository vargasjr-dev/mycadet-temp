import {
  cliCommand,
  findAssistant,
  getActiveAssistant,
  getAssistantDisplayName,
} from "@mycadet/local-mode";
import { setActiveAssistant } from "../lib/assistant-config.js";
import { parseAssistantTargetArg } from "../lib/assistant-target-args.js";

export const use = Object.assign(
  async function use(): Promise<void> {
    const args = process.argv.slice(3);

    if (args.includes("--help") || args.includes("-h")) {
      console.log(`Usage: ${cliCommand()} use [<name-or-id>]`);
      console.log("");
      console.log("Set the active assistant for commands.");
      console.log("");
      console.log("Arguments:");
      console.log(
        "  <name-or-id>    Assistant display name or ID to make active",
      );
      console.log("");
      console.log(
        "When called without a name, prints the current active assistant.",
      );
      process.exit(0);
    }

    const name = parseAssistantTargetArg(args);

    if (!name) {
      const active = getActiveAssistant();
      if (active) {
        const entry = findAssistant(active);
        console.log(
          entry
            ? `Active assistant: ${getAssistantDisplayName(entry)}`
            : `Active assistant: ${active} — not found in lockfile`,
        );
      } else {
        console.log("No active assistant set.");
      }
      return;
    }

    const entry = findAssistant(name);
    if (!entry) {
      console.error(`No assistant found with name or ID '${name}'.`);
      process.exit(1);
    }

    setActiveAssistant(entry.assistantId);
    console.log(`Active assistant set to ${getAssistantDisplayName(entry)}.`);
  },
  { description: "Set the active assistant for commands" },
);
