import {
  cliCommand,
  machineGet,
  machineResetKey,
  machineSetKey,
  formatMachineBytes,
  type MachineMutationResult,
} from "@mycadet/local-mode";

import { resolveTargetAssistant } from "../lib/assistant-config.js";

/**
 * `cadet machine` — the policy surface for host-independent machine settings.
 * The verbs are honest about what they can and cannot do YET: `set`/`reset`
 * only write the store and say when the policy takes effect; `apply`
 * (sleep → recreate → wake, with `plan` before it) lands in tranche 3. The
 * command owns UX (arg parsing, narration, exit codes) and delegates
 * everything else to the operations.
 */

const HELP = (cmd: string) =>
  `
Usage: ${cmd} machine get [<name>]
       ${cmd} machine set <key> <value> [<name>]
       ${cmd} machine reset [<path>] [<name>]

Inspect and configure the assistant's machine allocation policy —
host-independent settings stored on the assistant's lockfile entry.

Subcommands:
  get                  Show stored policy vs what is applied, with drift markers
  set <key> <value>    Store one key. Keys: memory.max, memory.high
  reset [<path>]       Clear back to defaults. Paths: memory, memory.max,
                       memory.high (no path clears the whole section)

Sizes are bytes, or suffixed: 512MiB, 8GiB, 1TiB (1024-based) or
100MB, 2GB (1000-based).

Applied state: docker assistants expose their container's cgroup flags;
local assistants take the policy as process hints at worker spawn.
`.trim();

function usageError(message: string): never {
  console.error(`Error: ${message}`);
  console.error(`Run '${cliCommand()} machine --help' for usage.`);
  process.exit(1);
}

/** Narrate a mutation: the pending semantics, or the failure + exit 1. */
function report(result: MachineMutationResult): void {
  if (!result.ok) {
    console.error(`Error: ${result.error}`);
    process.exit(1);
  }
  console.log(result.note);
}

/**
 * A stored-vs-applied drift line: the applied container was created with
 * flags that no longer match the stored policy. Hand-tampered flags and
 * un-applied `set`s both show up here.
 */
function driftLine(
  key: string,
  stored: number | undefined,
  applied: number | undefined,
): string {
  const storedLabel =
    stored === undefined
      ? "(default)"
      : `${formatMachineBytes(stored)} (${stored})`;
  const appliedLabel =
    applied === undefined
      ? "(unlimited)"
      : `${formatMachineBytes(applied)} (${applied})`;
  const drift = stored !== applied ? "  ⚠ differs" : "";
  return `  ${key.padEnd(14)}stored: ${storedLabel.padEnd(30)}applied: ${appliedLabel}${drift}`;
}

export const machine = Object.assign(
  async function machine(): Promise<void> {
    const args = process.argv.slice(3);
    const [subcommand, ...rest] = args.filter((a) => !a.startsWith("-"));
    if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
      console.log(HELP(cliCommand()));
      process.exit(0);
    }
    if (
      subcommand !== "get" &&
      subcommand !== "set" &&
      subcommand !== "reset"
    ) {
      usageError(`Unknown machine subcommand '${subcommand ?? ""}'.`);
    }

    const [first, second, third] = rest;

    if (subcommand === "get") {
      const entry = resolveTargetAssistant(first);
      const result = await machineGet(entry);
      if (!result.ok) {
        console.error(`Error: ${result.error}`);
        process.exit(1);
      }
      console.log(
        `Machine policy for '${entry.assistantId}' (${entry.cloud} assistant):`,
      );
      console.log(
        driftLine(
          "memory.max",
          result.stored?.memory?.max,
          result.applied?.memoryMax,
        ),
      );
      console.log(
        driftLine(
          "memory.high",
          result.stored?.memory?.high,
          result.applied?.memoryHigh,
        ),
      );
      if (result.note) console.log(`\n${result.note}`);
      return;
    }

    if (subcommand === "set") {
      if (first === undefined || second === undefined) {
        usageError(
          "'machine set' needs a key and a value, e.g. set memory.max 8GiB.",
        );
      }
      const entry = resolveTargetAssistant(third);
      const result = machineSetKey(entry, first, second);
      if (result.ok) {
        const key = first.split(".")[1] as "max" | "high";
        const bytes = result.machine?.memory?.[key];
        if (bytes !== undefined) {
          console.log(
            `Stored ${first} = ${formatMachineBytes(bytes)} (${bytes} bytes).`,
          );
        }
      }
      report(result);
      return;
    }

    // reset: an optional path, then an optional assistant. A dotted first
    // operand is the path; anything else is an assistant identifier.
    let path: string | undefined;
    let nameArg: string | undefined;
    if (first === undefined) {
      // Reset everything on the target assistant.
    } else if (first.includes(".")) {
      path = first;
      nameArg = second;
    } else if (second !== undefined) {
      usageError(
        `'${first}' is not a machine path. Valid paths: memory, memory.max, memory.high.`,
      );
    } else {
      nameArg = first;
    }
    const entry = resolveTargetAssistant(nameArg);
    const result = machineResetKey(entry, path);
    if (result.ok) {
      console.log(
        path
          ? `Cleared ${path}.`
          : "Cleared the machine section — all keys back to defaults.",
      );
    }
    report(result);
  },
  { description: "Inspect and configure the assistant's machine policy" },
);
