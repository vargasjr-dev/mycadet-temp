import {
  cliCommand,
  loadAllAssistants,
  parseWaitDuration,
  sleepAssistant,
  type SleepResult,
} from "@mycadet/local-mode";

import { resolveTargetAssistant } from "../lib/assistant-config.js";

export const sleep = Object.assign(
  async function sleep(): Promise<void> {
    const args = process.argv.slice(3);
    if (args.includes("--help") || args.includes("-h")) {
      console.log(
        `Usage: ${cliCommand()} sleep [<name> | --all] [--force] [--wait [<duration>]]`,
      );
      console.log("");
      console.log(
        "Gracefully stop all services; abort if they do not exit without forced termination.",
      );
      console.log("");
      console.log("Arguments:");
      console.log(
        "  <name>    Name of the assistant to stop, defaults to active or only local",
      );
      console.log("");
      console.log("Options:");
      console.log(
        "  --all     Stop every assistant across all remotes instead of one",
      );
      console.log(
        "  --force   Stop the assistant even if a phone call keepalive lease is active",
      );
      console.log(
        "  --wait    Wait for in-flight background work (heartbeats, memory jobs,",
      );
      console.log(
        "            schedules) to finish before stopping. Waits as long as it",
      );
      console.log(
        "            takes by default; pass a duration, e.g. --wait 90s or --wait 10m",
      );
      console.log(
        "            to bound the wait. Ctrl-C cancels and leaves the assistant running.",
      );
      process.exit(0);
    }

    const knownFlags = new Set(["--all", "--force", "--wait"]);
    const unknownFlag = args.find(
      (arg) =>
        arg.startsWith("-") &&
        !knownFlags.has(arg) &&
        !arg.startsWith("--wait="),
    );
    if (unknownFlag) {
      console.error(`Unknown sleep option: ${unknownFlag}`);
      process.exit(1);
    }

    const force = args.includes("--force");
    let wait = false;
    let waitMs: number | null = null;
    let waitDurationToken: string | null = null;
    const waitEqArg = args.find((a) => a.startsWith("--wait="));
    if (waitEqArg) {
      wait = true;
      const raw = waitEqArg.slice("--wait=".length);
      waitMs = parseWaitDuration(raw);
      if (waitMs == null) {
        console.error(
          `Error: invalid --wait duration '${raw}'. Use seconds or a value like 90s or 10m.`,
        );
        process.exit(1);
      }
    } else {
      const waitIndex = args.indexOf("--wait");
      if (waitIndex !== -1) {
        wait = true;
        // A bare `--wait` waits indefinitely; a following duration token
        // (e.g. `90s`, `10m`, `120`) bounds it. Anything else is the name arg.
        const next = args[waitIndex + 1];
        if (next !== undefined && /^\d+(s|m)?$/.test(next)) {
          waitDurationToken = next;
          waitMs = parseWaitDuration(next);
          if (waitMs == null) {
            console.error(
              `Error: invalid --wait duration '${next}'. Use seconds or a value like 90s or 10m.`,
            );
            process.exit(1);
          }
        }
      }
    }
    const nameArg = args.find(
      (a) => !a.startsWith("-") && a !== waitDurationToken,
    );
    const all = args.includes("--all");

    if (all && nameArg) {
      console.error("Error: --all cannot be combined with an assistant name.");
      process.exit(1);
    }

    // Ctrl-C during a `--wait` drain aborts it (the operation releases the
    // quiesce lease and reports cancelled) instead of killing the stop
    // midway. One controller serves the whole command; every drain shares it.
    const drainAbort = new AbortController();
    process.once("SIGINT", () => drainAbort.abort());
    const options = {
      force,
      wait,
      waitMs,
      signal: drainAbort.signal,
      log: (line: string): void => console.log(line),
    };

    if (all) {
      await sleepAll(options);
      return;
    }

    const entry = resolveTargetAssistant(nameArg);
    if (entry.cloud === "docker" && wait) {
      console.log(
        "--wait is not supported for Docker assistants yet — stopping containers now.",
      );
    }
    const result = await sleepAssistant(entry, options);
    if (!result.ok) {
      console.error(`Error: ${result.error}`);
    }
    narrate(result);
    process.exit(exitCodeFor(result));
  },
  { description: "Stop the assistant process" },
);

type SleepOptions = {
  force: boolean;
  wait: boolean;
  waitMs: number | null;
  signal: AbortSignal;
  log: (line: string) => void;
};

/**
 * Stop every assistant this CLI's environment knows about — `--all`. The
 * CLI only ever reaches one environment, so this is the current env's
 * lockfile. Same per-assistant stop as the single path, but one assistant's
 * failure (or an unmanageable runtime) never blocks the others; a failure
 * only decides the exit code.
 */
async function sleepAll(opts: SleepOptions): Promise<void> {
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
    if (entry.cloud === "docker" && opts.wait) {
      console.log(
        "--wait is not supported for Docker assistants yet — stopping containers now.",
      );
    }
    const result = await sleepAssistant(entry, opts);
    if (result.ok && result.cancelled) {
      // A cancelled drain is the user asking to stop — honor it immediately.
      console.log("Sleep cancelled — the assistant is still running.");
      process.exit(130);
    }
    if (!result.ok) {
      failures++;
      console.error(
        `Error: failed to stop '${entry.assistantId}': ${result.error}`,
      );
      continue;
    }
    narrate(result);
  }
  if (failures > 0) {
    process.exit(1);
  }
}

/** Map the operation's structured result onto the command's narration. */
function narrate(result: SleepResult): void {
  if (!result.ok) return;
  if (result.cancelled) {
    console.log("Sleep cancelled — the assistant is still running.");
    return;
  }
  if (result.kind === "containers") {
    console.log("Docker containers stopped.");
    return;
  }
  for (const note of result.notes) {
    console.log(note);
  }
  console.log(
    result.services.assistant === "stopped"
      ? "Assistant stopped."
      : "Assistant is not running.",
  );
  console.log(
    result.services.gateway === "stopped"
      ? "Gateway stopped."
      : "Gateway is not running.",
  );
  if (result.services.ces === "stopped") {
    console.log("credential-executor stopped.");
  }
}

/** 130 for a user-cancelled wait, 1 for a failed stop, 0 otherwise. */
function exitCodeFor(result: SleepResult): number {
  if (!result.ok) return 1;
  return result.cancelled ? 130 : 0;
}
