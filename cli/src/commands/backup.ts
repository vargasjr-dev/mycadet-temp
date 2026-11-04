import { cliCommand, formatSize } from "@mycadet/local-mode";
import { stat } from "node:fs/promises";
import { findAssistantByName } from "../lib/assistant-config.js";
import { backupAssistant } from "@mycadet/local-mode";

export const backup = Object.assign(
  async function backup(): Promise<void> {
    const args = process.argv.slice(3);
    if (args.includes("--help") || args.includes("-h")) {
      console.log(`Usage: ${cliCommand()} backup <name>`);
      console.log(
        "Local/Docker: gracefully stop services, capture all persistent roots as tar.gz, then resume.",
      );
      console.log(
        "Cloud: create a backup through the cloud API using your cloud session.",
      );
      console.log(`Example: ${cliCommand()} backup my-assistant`);
      return;
    }
    const name = args[0];
    if (!name || name.startsWith("-"))
      throw new Error(`Usage: ${cliCommand()} backup <name>`);
    if (args.length > 1) throw new Error(`Unknown backup option: ${args[1]}`);
    const entry = findAssistantByName(name);
    if (!entry) throw new Error(`No assistant found with name '${name}'.`);
    const result = await backupAssistant(entry);
    if (!result.ok) throw new Error(result.error);
    if (result.kind === "cloud") {
      console.log("Cloud backup is ready.");
      return;
    }
    console.log(`Backup saved to ${result.path}`);
    console.log(`Size: ${formatSize((await stat(result.path)).size)}`);
  },
  {
    description:
      "Back up persistent local/Docker roots or create a cloud backup",
  },
);
