import { getGatewayUrl } from "@mycadet/local-mode/contract";
import type { LockfileAssistant } from "@mycadet/local-mode/contract";

import {
  cliCommandName,
  dockerResourceNames,
  formatAssistantLookupError,
  getActiveAssistant,
  getAssistantDisplayName,
  lookupAssistantByIdentifier,
  retireAssistant,
} from "@mycadet/local-mode";
import { parseAssistantTargetArg } from "../lib/assistant-target-args.js";
import {
  canPromptForConfirmation,
  confirmAction,
} from "../lib/confirm-action.js";
import { printInstanceDetails } from "../lib/instance-details.js";

interface RetireArgs {
  name?: string;
  source?: string;
  yes: boolean;
}

function parseRetireArgs(args: string[]): RetireArgs {
  let source: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--source" && args[i + 1]) {
      source = args[i + 1];
      i++;
    }
  }

  return {
    name: parseAssistantTargetArg(args, ["--source"]),
    source,
    yes: args.includes("--yes"),
  };
}

function printRetireTarget(entry: LockfileAssistant): void {
  console.log("Assistant to retire:");
  printInstanceDetails(
    {
      name: getAssistantDisplayName(entry),
      id: entry.assistantId,
      cloud: entry.cloud,
      runtime: getGatewayUrl(entry),
      ...(entry.cloud === "local" && entry.instanceDir
        ? { root: entry.instanceDir }
        : {}),
      ...(entry.cloud === "docker"
        ? {
            container: dockerResourceNames(entry.assistantId)
              .assistantContainer,
          }
        : {}),
    },
    console.log,
  );
  console.log("");
}

export const retire = Object.assign(
  async function retire(): Promise<void> {
    await retireInner();
  },
  { description: "Delete an assistant instance" },
);

async function retireInner(): Promise<void> {
  const args = process.argv.slice(3);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      `Usage: ${cliCommandName()} retire [<name-or-id>] [--source <source>] [--yes]`,
    );
    console.log("");
    console.log("Delete an assistant instance and archive its data.");
    console.log(
      "With no name or ID, retires the active assistant — see `cadet use`. By default, retire prints the assistant name, ID, cloud, and runtime before asking for confirmation.",
    );
    console.log("");
    console.log("Arguments:");
    console.log(
      "  <name-or-id>         Assistant display name or ID to retire, defaults to the active assistant",
    );
    console.log("");
    console.log("Options:");
    console.log("  --source <source>    Source identifier for the retirement");
    console.log(
      "  --yes                Skip the interactive confirmation prompt",
    );
    process.exit(0);
  }

  const parsed = parseRetireArgs(args);
  // No name given: retire whichever assistant is currently in use.
  const name = parsed.name ?? getActiveAssistant() ?? undefined;

  if (!name) {
    console.error(
      "Error: No assistant specified and no active assistant. Pass a name or ID, or pick one with `cadet use <name>`.",
    );
    console.error(
      `Usage: ${cliCommandName()} retire <name-or-id> [--source <source>] [--yes]`,
    );
    process.exit(1);
  }

  const lookup = lookupAssistantByIdentifier(name);
  if (lookup.status !== "found") {
    console.error(formatAssistantLookupError(name, lookup));
    console.error(
      `Run '${cliCommandName()} hatch' first, or check the instance name.`,
    );
    process.exit(1);
  }

  const entry = lookup.entry;

  printRetireTarget(entry);

  if (!parsed.yes) {
    if (!canPromptForConfirmation()) {
      console.error(
        "Error: Refusing to retire without confirmation in a non-interactive terminal.",
      );
      console.error("Re-run with --yes to confirm from automation.");
      process.exit(1);
    }

    const confirmed = await confirmAction(
      "Press Enter to retire, or Esc/q to cancel: ",
    );
    if (!confirmed) {
      console.log("Retire cancelled.");
      process.exit(1);
    }
  }

  // The operation owns the teardown: per-cloud dispatch, the lockfile entry
  // removal, and the dock-label sentinel — the same headless core the
  // hosts' retire route runs. Failures come back structured; the exit-code
  // UX is this command's.
  const result = await retireAssistant(entry);
  if (!result.ok) {
    console.error(`Error: ${result.error}`);
    process.exit(1);
  }
}
