import {
  cliCommand,
  machineGet,
  machineResetKey,
  machineSetKey,
  planMachine,
  sleepAssistant,
  type MachineMutationResult,
  type MachinePlanChange,
} from "@mycadet/local-mode";

import { resolveTargetAssistant } from "../lib/assistant-config.js";
import { wakeAssistant } from "./wake.js";

/**
 * `cadet machine` — the policy surface for host-independent machine settings.
 * `set`/`reset` write the store and say when the policy takes effect;
 * `plan` is the read-only stored-vs-applied diff (the terraform inspect
 * half, powered by the operation that owns the applied-state reader);
 * `apply` is the CLI's sleep → recreate → wake composition — the daemon
 * cannot recreate its own container, so applying stays a CLI/supervisor
 * flow. The command owns UX (arg parsing, narration, exit codes) and
 * delegates everything else to the operations.
 */

const HELP = (cmd: string) =>
  `
Usage: ${cmd} machine get [<path>] [<name>]
       ${cmd} machine plan [<name>]
       ${cmd} machine apply [<name>]
       ${cmd} machine set <path> <value> [<name>]
       ${cmd} machine reset [<path>] [<name>]

Inspect and configure the assistant's machine allocation policy —
host-independent settings stored on the assistant's lockfile entry.

Subcommands:
  get <key>            Show stored policy vs what is applied, with drift markers
  plan                 Read-only diff of stored policy vs what is applied
  apply                Recreate the containers so the stored policy takes effect
  set <path> <value>   Store one policy value
  reset [<path>]       Clear back to defaults (no path clears everything)

Values are byte sizes; suffixes like 512MiB or 8GiB are accepted. A set
takes effect per its remote's semantics — the command tells you when.
`.trim();

function usageError(message: string): never {
  console.error(`Error: ${message}`);
  console.error(`Run '${cliCommand()} machine --help' for usage.`);
  process.exit(1);
}

/** Exact-fit unit labels for byte sizes; falls through to raw bytes. */
function formatMachineBytes(bytes: number): string {
  for (const [suffix, unit] of [
    ["TiB", 1024 ** 4],
    ["GiB", 1024 ** 3],
    ["MiB", 1024 ** 2],
    ["KiB", 1024],
  ] as const) {
    if (bytes % unit === 0) return `${bytes / unit}${suffix}`;
  }
  return `${bytes}B`;
}

/** Narrate a mutation: the pending semantics, or the failure + exit 1. */
function report(result: MachineMutationResult): void {
  if (!result.ok) {
    console.error(`Error: ${result.error}`);
    process.exit(1);
  }
  console.log(result.note);
}

/** One stored policy line: unset keys read as the default they stand for. */
function storedLine(path: string, value: number | undefined): string {
  const label =
    value === undefined
      ? "(default)"
      : `${formatMachineBytes(value)} (${value})`;
  return `  ${path.padEnd(14)}${label}`;
}

/** Render one plan change with the same byte formatting `get` uses. */
function changeLine(change: MachinePlanChange): string {
  const side = (bytes: number | undefined) =>
    bytes === undefined ? "unlimited" : formatMachineBytes(bytes);
  return `  ⚠ ${change.field}: ${side(change.from)} → ${side(change.to)}`;
}

/** The applied half of a docker plan, in the flags plan compares against. */
function appliedLine(applied: {
  maxBytes?: number;
  highBytes?: number;
  swapBytes?: number;
}): string {
  if (applied.maxBytes === undefined && applied.highBytes === undefined) {
    return "unlimited (no memory flags on the container)";
  }
  const parts: string[] = [];
  if (applied.maxBytes !== undefined)
    parts.push(`--memory ${formatMachineBytes(applied.maxBytes)}`);
  if (applied.highBytes !== undefined)
    parts.push(`--memory-reservation ${formatMachineBytes(applied.highBytes)}`);
  if (applied.swapBytes !== undefined)
    parts.push(`--memory-swap ${formatMachineBytes(applied.swapBytes)}`);
  return parts.join(", ");
}

/** The dotted paths `get`/`reset` accept; `set` needs a leaf. */
const SECTION_PATHS = ["memory", "memory.max", "memory.high"];

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
      subcommand !== "plan" &&
      subcommand !== "apply" &&
      subcommand !== "set" &&
      subcommand !== "reset"
    ) {
      usageError(`Unknown machine subcommand '${subcommand ?? ""}'.`);
    }

    const [first, second, third] = rest;

    // get/reset: an optional dotted path, then an optional assistant. A
    // dotted first operand is the path; anything else is an identifier.
    // plan/apply take an assistant name only.
    let path: string | undefined;
    let nameArg: string | undefined;
    if (subcommand === "plan" || subcommand === "apply") {
      nameArg = first;
    } else if (subcommand !== "set") {
      if (first !== undefined && first.includes(".")) {
        if (!SECTION_PATHS.includes(first)) {
          usageError(
            `Unknown machine path '${first}'. Valid paths: ${SECTION_PATHS.join(", ")}.`,
          );
        }
        path = first;
        nameArg = second;
      } else if (second !== undefined) {
        usageError(
          `'${first}' is not a machine path. Valid paths: ${SECTION_PATHS.join(", ")}.`,
        );
      } else {
        nameArg = first;
      }
    }

    if (subcommand === "get") {
      const entry = resolveTargetAssistant(nameArg);
      const result = machineGet(entry);
      if (!result.ok) {
        console.error(`Error: ${result.error}`);
        process.exit(1);
      }
      const paths =
        path !== undefined
          ? [path]
          : SECTION_PATHS.filter((p) => p !== "memory");
      console.log(
        `Machine policy for '${entry.assistantId}' (${entry.cloud} assistant):`,
      );
      for (const p of paths) {
        const leaf = p.split(".")[1] as "max" | "high";
        console.log(storedLine(p, result.machine?.memory?.[leaf]));
      }
      return;
    }

    if (subcommand === "plan") {
      const entry = resolveTargetAssistant(nameArg);
      const result = await planMachine(entry);
      if (!result.ok) {
        console.error(`Error: ${result.error}`);
        process.exit(1);
      }
      console.log(
        `Machine plan for '${entry.assistantId}' (${result.cloud} assistant):`,
      );
      const stored = result.stored;
      console.log(
        `  stored:        ${
          stored
            ? `memory.max ${stored.max === undefined ? "(default)" : formatMachineBytes(stored.max)}, memory.high ${stored.high === undefined ? "(default)" : formatMachineBytes(stored.high)}`
            : "none"
        }`,
      );
      console.log(
        `  applied:       ${result.applied ? appliedLine(result.applied) : "nothing live to compare"}`,
      );
      for (const change of result.changes) {
        console.log(changeLine(change));
      }
      if (result.requiresRecreate) {
        console.log(
          `  Recreate required — run \`${cliCommand()} machine apply\`.`,
        );
      }
      if (result.note) console.log(`  ${result.note}`);
      return;
    }

    if (subcommand === "apply") {
      const entry = resolveTargetAssistant(nameArg);
      if (entry.cloud === "local") {
        console.log(
          "No restart required — 'local' policy is a process hint that takes effect at the next worker spawn.",
        );
        return;
      }
      if (entry.cloud !== "docker") {
        console.error(
          `Error: '${cliCommand()} machine apply' is unsupported for a ${entry.cloud} assistant.`,
        );
        process.exit(1);
      }
      const stopped = await sleepAssistant(entry);
      if (!stopped.ok) {
        console.error(`Error: ${stopped.error}`);
        process.exit(1);
      }
      console.log(
        "Assistant slept — recreating the containers with the stored policy...",
      );
      const woken = await wakeAssistant(entry, {
        watch: false,
        foreground: false,
      });
      if (!woken.ok) {
        console.error(`Error: ${woken.error}`);
        process.exit(1);
      }
      return;
    }

    if (subcommand === "set") {
      if (first === undefined || second === undefined) {
        usageError(
          "'machine set' needs a path and a value, e.g. set memory.max 8GiB.",
        );
      }
      const entry = resolveTargetAssistant(third);
      const result = machineSetKey(entry, first, second);
      if (result.ok && result.value !== undefined) {
        console.log(
          `Stored ${first} = ${formatMachineBytes(result.value)} (${result.value} bytes).`,
        );
      }
      report(result);
      return;
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
