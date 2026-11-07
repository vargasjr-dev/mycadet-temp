import { cliCommand, teleportAssistant } from "@mycadet/local-mode";

import { findAssistantByName } from "../lib/assistant-config.js";

function printHelp(): void {
  console.log(
    `Usage: ${cliCommand()} teleport --from <assistant> <--local | --docker>`,
  );
  console.log(
    "Move the whole installation to another remote, keeping the assistant name.",
  );
  console.log(
    "Cloud teleport is unavailable until cloud root archive transfer is supported.",
  );
}

export function parseArgs(argv: string[]): {
  from: string | undefined;
  targetEnv: "local" | "docker" | "cloud" | undefined;
  help: boolean;
} {
  let from: string | undefined;
  let targetEnv: "local" | "docker" | "cloud" | undefined;
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

  return { from, targetEnv, help };
}

export const teleport = Object.assign(
  async function teleport(): Promise<void> {
    const args = process.argv.slice(3);
    const { from, targetEnv, help } = parseArgs(args);

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
      target: targetEnv,
      log: (line) => console.log(line),
    });

    if (!result.ok) {
      console.error(`Error: ${result.error}`);
      process.exit(1);
    }
  },
  { description: "Move an installation to another remote, keeping its name" },
);
