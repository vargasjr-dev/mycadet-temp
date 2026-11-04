import {
  cliCommand,
  parseWaitDuration,
  restartAllAssistants,
  restartAssistant,
} from "@mycadet/local-mode";

import { resolveTargetAssistant } from "../lib/assistant-config.js";
import { narrate } from "../lib/sleep-narration.js";

export const restart = Object.assign(
  async function restart(): Promise<void> {
    const args = process.argv.slice(3);
    if (args.includes("--help") || args.includes("-h")) {
      console.log(
        `Usage: ${cliCommand()} restart [<name> | --all] [--force] [--wait [<duration>]] [--repair-guardian]`,
      );
      console.log("");
      console.log("Sleep, then wake the assistant.");
      console.log("");
      console.log(
        "  --force            Stop the assistant even if a phone call keepalive lease is active",
      );
      console.log(
        "  --wait             Wait for in-flight background work before stopping;",
        "pass a duration, e.g. --wait 90s, to bound the wait",
      );
      console.log(
        "  --repair-guardian  Re-provision the guardian token during the wake",
      );
      process.exit(0);
    }

    const knownFlags = new Set([
      "--all",
      "--force",
      "--wait",
      "--repair-guardian",
    ]);
    const unknownFlag = args.find(
      (arg) =>
        arg.startsWith("-") &&
        !knownFlags.has(arg) &&
        !arg.startsWith("--wait="),
    );
    if (unknownFlag) {
      console.error(`Unknown restart option: ${unknownFlag}`);
      process.exit(1);
    }

    const all = args.includes("--all");
    const nameArg = args.find((a) => !a.startsWith("-"));
    if (all && nameArg) {
      console.error("Error: --all cannot be combined with an assistant name.");
      process.exit(1);
    }
    const repairGuardian = args.includes("--repair-guardian");
    if (all && repairGuardian) {
      console.error("Error: --all cannot be combined with --repair-guardian.");
      process.exit(1);
    }

    // Same --wait grammar as sleep: bare waits indefinitely, a duration
    // token (90s, 10m, 120) bounds it.
    const force = args.includes("--force");
    const watch = args.includes("--watch");
    let wait = false;
    let waitMs: number | null = null;
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
        const next = args[waitIndex + 1];
        if (next !== undefined && /^\d+(s|m)?$/.test(next)) {
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

    // Ctrl-C during a --wait drain aborts the stop and leaves the assistant
    // running (the operation reports it) — the same contract as sleep.
    const drainAbort = new AbortController();
    process.once("SIGINT", () => drainAbort.abort());
    const opts = {
      force,
      wait,
      waitMs,
      watch,
      repairGuardian,
      signal: drainAbort.signal,
      log: (line: string): void => console.log(line),
    };

    if (all) {
      const { reports } = await restartAllAssistants(opts);
      let failures = 0;
      let cancelled = false;
      for (const report of reports) {
        narrate(report.sleep);
        if (report.sleep.ok && report.sleep.cancelled) cancelled = true;
        if (report.sleep.ok && !report.sleep.cancelled) {
          if (report.wake && !report.wake.ok) {
            failures++;
            console.error(
              `Error: failed to wake '${report.assistantId}': ${report.wake.error}`,
            );
            continue;
          }
          console.log("Wake complete.");
        }
        if (!report.sleep.ok) failures++;
      }
      if (cancelled) process.exit(130);
      if (failures > 0) process.exit(1);
      return;
    }

    const entry = resolveTargetAssistant(nameArg);
    if (entry.cloud === "docker" && wait) {
      console.log(
        "--wait is not supported for Docker assistants yet — stopping containers now.",
      );
    }
    const result = await restartAssistant(entry, opts);
    if (!result.ok) {
      if (result.phase === "sleep" && !result.cancelled && result.sleep) {
        narrate(result.sleep);
      }
      console.error(`Error: ${result.error}`);
      process.exit(result.cancelled ? 130 : 1);
    }
    narrate(result.sleep);
    console.log("Wake complete.");
  },
  { description: "Sleep, then wake the assistant" },
);
