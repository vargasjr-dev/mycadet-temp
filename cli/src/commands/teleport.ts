import { teleportHostInstallation } from "../lib/host-teleport.js";
import { cliCommandName } from "@mycadet/local-mode";
import { findAssistantByName } from "../lib/assistant-config.js";

function printHelp(): void {
  console.log(
    `Usage: ${cliCommandName()} teleport --from <assistant> <--local | --docker> [name] [--keep-source] [--dry-run]`,
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

    if (!from) {
      printHelp();
      process.exit(1);
    }

    if (!targetEnv) {
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

    const fromCloud = fromEntry.cloud;

    if (fromCloud === "apple-container") {
      console.error(
        `Error: '${from}' uses the Apple Containers runtime. Teleport is not yet supported for this topology.`,
      );
      process.exit(1);
    }

    // Early same-environment guard — compare source cloud against the CLI flag
    // BEFORE exporting or hatching, to avoid creating orphaned assistants.
    if (fromCloud === targetEnv) {
      console.error(
        `Cannot teleport between two ${targetEnv} assistants. Teleport transfers data across different environments.`,
      );
      process.exit(1);
    }

    if (
      (fromCloud === "local" || fromCloud === "docker") &&
      (targetEnv === "local" || targetEnv === "docker")
    ) {
      try {
        await teleportHostInstallation(fromEntry, targetEnv, targetName, {
          keepSource,
          dryRun,
        });
      } catch (error) {
        console.error(
          `Error: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
      }
      return;
    }

    console.error(
      "Cloud teleport is unavailable until cloud root archive transfer is supported. No installation was changed.",
    );
    process.exit(1);
  },
  { description: "Move an installation between local and Docker storage" },
);
