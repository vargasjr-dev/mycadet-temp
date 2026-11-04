import {
  cliCommand,
  loadAllAssistants,
  wakeAssistant,
} from "@mycadet/local-mode";

import { resolveTargetAssistant } from "../lib/assistant-config.js";

export const wake = Object.assign(
  async function wake(): Promise<void> {
    const args = process.argv.slice(3);
    if (args.includes("--help") || args.includes("-h")) {
      console.log(`Usage: ${cliCommand()} wake [<name> | --all] [options]`);
      console.log("");
      console.log("Start the assistant and gateway processes.");
      console.log("");
      console.log("Arguments:");
      console.log(
        "  <name>    Name of the assistant to start, defaults to active or only local",
      );
      console.log("");
      console.log("Options:");
      console.log(
        "  --all          Start every assistant across all remotes instead of one",
      );
      console.log(
        "  --watch        Run assistant and gateway in watch mode (hot reload on source changes)",
      );
      process.exit(0);
    }

    const watch = args.includes("--watch");
    const nameArg = args.find((a) => !a.startsWith("-"));
    const all = args.includes("--all");

    if (all && nameArg) {
      console.error("Error: --all cannot be combined with an assistant name.");
      process.exit(1);
    }

    if (all) {
      await wakeAll({ watch });
      return;
    }

    const entry = resolveTargetAssistant(nameArg);
    const result = await wakeAssistant(entry, { watch });
    if (!result.ok) {
      console.error(`Error: ${result.error}`);
      process.exit(1);
    }
    console.log("Wake complete.");
  },
  { description: "Start the assistant and gateway" },
);

/**
 * Start every assistant this CLI's environment knows about — `--all`. The
 * CLI only ever reaches one environment, so this is the current env's
 * lockfile. Same per-assistant wake as the single path, but one assistant's
 * failure never blocks the others; failures only decide the exit code.
 */
async function wakeAll(opts: { watch: boolean }): Promise<void> {
  const entries = loadAllAssistants();
  if (entries.length === 0) {
    console.error(
      `Error: no assistants found. Run '${cliCommand()} hatch' first.`,
    );
    process.exit(1);
  }

  let failures = 0;
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.assistantId)) continue;
    seen.add(entry.assistantId);
    if (entry.cloud === "apple-container") {
      console.log(
        `Skipping '${entry.assistantId}' (apple-container) — its lifecycle is managed elsewhere.`,
      );
      continue;
    }
    const result = await wakeAssistant(entry, { watch: opts.watch });
    if (!result.ok) {
      failures++;
      console.error(
        `Error: failed to wake '${entry.assistantId}': ${result.error}`,
      );
    }
  }
  if (failures > 0) {
    process.exit(1);
  }
}
