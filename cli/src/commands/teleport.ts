import { cliCommand, teleportAssistant } from "@mycadet/local-mode";

import {
  findAssistantByName,
  setActiveAssistant,
} from "../lib/assistant-config.js";

function printHelp(): void {
  console.log(
    `Usage: ${cliCommand()} teleport --from <assistant> <--local | --docker> [name] [--keep-source] [--dry-run]`,
  );
  console.log(
    "Move the whole installation between local and Docker storage using root tar archives.",
  );
  console.log(
    "Cloud teleport is unavailable until cloud root archive transfer is supported.",
  );
}

export function parseArgs(argv: string[]): {
  from: string | undefined;
  targetEnv: "local" | "docker" | "cloud" | undefined;
  targetName: string | undefined;
  keepSource: boolean;
  dryRun: boolean;
  help: boolean;
} {
  let from: string | undefined;
  let targetEnv: "local" | "docker" | "cloud" | undefined;
  let targetName: string | undefined;
  let keepSource = false;
  let dryRun = false;
  let help = false;

  const envFlags: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--from" && i + 1 < argv.length) {
      if (argv[i + 1].startsWith("--")) {
        continue;
      }
      from = argv[++i];
    } else if (arg === "--local" || arg === "--docker" || arg === "--cloud") {
      const env =
        arg === "--local" ? "local" : arg === "--docker" ? "docker" : "cloud";
      envFlags.push(env);
      targetEnv = env;
      // Peek at next arg for optional target name
      if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        targetName = argv[++i];
      }
    } else if (arg === "--keep-source") {
      keepSource = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    }
  }

  if (envFlags.length > 1) {
    console.error(
      "Error: Only one environment flag (--local, --docker, --cloud) may be specified.",
    );
    process.exit(1);
  }

  return { from, targetEnv, targetName, keepSource, dryRun, help };
}

export const teleport = Object.assign(
  async function teleport(): Promise<void> {
    const args = process.argv.slice(3);
    const { from, targetEnv, targetName, keepSource, dryRun, help } =
      parseArgs(args);

    if (help) {
      printHelp();
      process.exit(0);
    }

    if (!from || !targetEnv) {
      printHelp();
      process.exit(1);
    }

    // Look up source assistant
    const fromEntry = findAssistantByName(from);
    if (!fromEntry) {
      console.error(
        `Assistant '${from}' not found in lockfile. Run \`cadet ps\` to see available assistants.`,
      );
      process.exit(1);
    }

    const result = await teleportAssistant({
      source: fromEntry,
      targetEnv,
      targetName,
      keepSource,
      dryRun,
      log: (line) => console.log(line),
    });

    if (!result.ok) {
      console.error(`Error: ${result.error}`);
      process.exit(1);
    }
    if (result.kind === "dry-run") {
      for (const line of result.lines) console.log(line);
      return;
    }
    setActiveAssistant(result.targetId);
  },
  { description: "Move an installation between local and Docker storage" },
);
