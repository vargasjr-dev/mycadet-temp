import { existsSync, statSync } from "fs";

import { findAssistantByName } from "../lib/assistant-config.js";
import { cliCommand, restoreAssistant } from "@mycadet/local-mode";

function printUsage(): void {
  console.log(
    `Usage: ${cliCommand()} restore <name> [--from <path>] [--dry-run]`,
  );
  console.log("");
  console.log(
    "Restore all persistent roots from a tar archive into an assistant.",
  );
  console.log(
    "Without --from, recovers a retired assistant from its archive in",
  );
  console.log("$XDG_DATA_HOME/cadet/retired/ and starts it again.");
  console.log("");
  console.log("Arguments:");
  console.log("  <name>               Name of the assistant to restore into");
  console.log("");
  console.log("Options:");
  console.log("  --from <path>        Path to the .tar.gz file (required)");
  console.log(
    "  --dry-run            Show what would change without applying (data-only)",
  );
  console.log("");
  console.log("Examples:");
  console.log(`  ${cliCommand()} restore my-retired-assistant`);
  console.log(`  ${cliCommand()} restore my-assistant --from backup.tar.gz`);
  console.log(
    `  ${cliCommand()} restore my-cloud-assistant --from backup.tar.gz`,
  );
  console.log(
    `  ${cliCommand()} restore my-assistant --from backup.tar.gz --dry-run`,
  );
}

function parseArgs(argv: string[]): {
  name: string | undefined;
  fromPath: string | undefined;
  dryRun: boolean;
  help: boolean;
} {
  const args = argv.slice(3);

  if (args.includes("--help") || args.includes("-h")) {
    return {
      name: undefined,
      fromPath: undefined,
      dryRun: false,
      help: true,
    };
  }

  let fromPath: string | undefined;
  const dryRun = args.includes("--dry-run");
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--from" && args[i + 1]) {
      fromPath = args[i + 1];
      i++; // skip the value
    } else if (args[i] === "--dry-run") {
      // already handled above
    } else if (args[i].startsWith("-")) {
      throw new Error(`Unknown restore option: ${args[i]}`);
    } else {
      positionals.push(args[i]);
    }
  }

  return { name: positionals[0], fromPath, dryRun, help: false };
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** The dry-run report: what a real import would change. */
function printPreflight(preflight: {
  filesToCreate: number;
  filesToOverwrite: number;
  filesUnchanged: number;
  totalFiles: number;
  conflicts: string[];
  files: { path: string; action: string }[];
}): void {
  console.log("Preflight analysis:");
  console.log(`  Files to create:    ${preflight.filesToCreate}`);
  console.log(`  Files to overwrite: ${preflight.filesToOverwrite}`);
  console.log(`  Files unchanged:    ${preflight.filesUnchanged}`);
  console.log(`  Total:              ${preflight.totalFiles}`);
  console.log("");

  console.log(
    `Conflicts: ${preflight.conflicts.length > 0 ? preflight.conflicts.join(", ") : "none"}`,
  );

  // List individual files with their action
  if (preflight.files.length > 0) {
    console.log("");
    console.log("Files:");
    for (const file of preflight.files) {
      console.log(`  [${file.action}] ${file.path}`);
    }
  }
}

/** The import report: what the restore changed. */
function printImportReport(imported: {
  filesCreated: number;
  filesOverwritten: number;
  filesSkipped: number;
  backupsCreated: number;
  warnings: string[];
}): void {
  console.log("✅ Restore complete.");
  console.log(`  Files created:     ${imported.filesCreated}`);
  console.log(`  Files overwritten: ${imported.filesOverwritten}`);
  console.log(`  Files skipped:     ${imported.filesSkipped}`);
  console.log(`  Backups created:   ${imported.backupsCreated}`);

  if (imported.warnings.length > 0) {
    console.log("");
    console.log("Warnings:");
    for (const warning of imported.warnings) {
      console.log(`  ⚠️  ${warning}`);
    }
  }
}

export const restore = Object.assign(
  async function restore(): Promise<void> {
    const { name, fromPath, dryRun, help } = parseArgs(process.argv);

    if (help) {
      printUsage();
      process.exit(0);
    }

    if (!name) {
      console.error("Error: <name> is required.");
      console.error("");
      printUsage();
      process.exit(1);
    }

    // Without --from: recover a retired assistant from its retire archive.
    let entry: ReturnType<typeof findAssistantByName>;
    if (fromPath) {
      // Look up the instance
      entry = findAssistantByName(name);
      if (!entry) {
        console.error(`Error: No assistant found with name '${name}'.`);
        console.error(`Run '${cliCommand()} ps' to see available assistants.`);
        process.exit(1);
      }

      // Verify .tar.gz file exists
      if (!existsSync(fromPath)) {
        console.error(`Error: File not found: ${fromPath}`);
        process.exit(1);
      }

      const sizeMB = (statSync(fromPath).size / (1024 * 1024)).toFixed(1);
      console.log(`Reading ${fromPath} — ${sizeMB} MB...`);
    }

    const result = fromPath
      ? await restoreAssistant({
          entry: entry!,
          fromPath,
          dryRun,
          log: (line) => console.log(line),
        })
      : await restoreAssistant({ name });

    if (!result.ok) fail(result.error);

    if (result.kind === "recovery") {
      console.log(`✅ Recovered assistant '${name}'.`);
      return;
    }

    if (result.kind === "cloud") {
      if (result.dryRun) printPreflight(result.preflight);
      else printImportReport(result.import);
      return;
    }

    if (result.dryRun)
      console.log(
        "Root archive is valid; restore would replace workspace, gateway security, CES security and CES data. No services were stopped.",
      );
    else {
      console.log("Restore complete.");
      console.log(`Previous state retained at ${result.recoveryPath}`);
    }
  },
  {
    description:
      "Restore persistent roots from tar, or recover a retired assistant",
  },
);
