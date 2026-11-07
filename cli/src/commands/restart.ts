import { cliCommand, restartAssistant } from "@mycadet/local-mode";

import { resolveTargetAssistant } from "../lib/assistant-config.js";

export const restart = Object.assign(
  async function restart(): Promise<void> {
    const args = process.argv.slice(3);
    if (args.includes("--help") || args.includes("-h")) {
      console.log(`Usage: ${cliCommand()} restart [<name> | --all]`);
      console.log("");
      console.log("Sleep, then wake the assistant.");
      process.exit(0);
    }

    const knownFlags = new Set(["--all"]);
    const unknownFlag = args.find(
      (arg) => arg.startsWith("-") && !knownFlags.has(arg),
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

    const entry = all ? undefined : resolveTargetAssistant(nameArg);
    const { ok, reports } = await restartAssistant({
      entry,
      all,
      log: (line: string): void => console.log(line),
    });

    let cancelled = false;
    let failures = 0;
    for (const report of reports) {
      if (report.sleep.ok && report.sleep.cancelled) {
        cancelled = true;
        continue;
      }
      if (!report.sleep.ok) {
        failures++;
        console.error(
          `Error: failed to stop '${report.assistantId}': ${report.sleep.error}`,
        );
        continue;
      }
      if (report.wake && !report.wake.ok) {
        failures++;
        console.error(
          `Error: failed to wake '${report.assistantId}': ${report.wake.error}`,
        );
        continue;
      }
      console.log(`Restarted '${report.assistantId}'.`);
    }
    if (cancelled) process.exit(130);
    if (failures > 0 || !ok) process.exit(1);
  },
  { description: "Sleep, then wake the assistant" },
);
