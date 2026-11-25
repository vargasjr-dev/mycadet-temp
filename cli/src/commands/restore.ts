import { existsSync, statSync } from "fs";

import { Command } from "commander";

import { findAssistant } from "@mycadet/local-mode";
import type { LockfileAssistant } from "@mycadet/local-mode/contract";
import { cliCommand, restoreAssistant } from "@mycadet/local-mode";

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

/** The `cadet restore` action: restore a backup, or recover a retired assistant. */
async function restoreFlow(
  name: string,
  opts: { from?: string; dryRun?: boolean },
): Promise<void> {
  const fromPath = opts.from;
  const dryRun = opts.dryRun ?? false;

  // Without --from: recover a retired assistant from its retire archive.
  let entry: LockfileAssistant;
  if (fromPath) {
    // Look up the instance
    const found = findAssistant(name);
    if (!found) {
      console.error(`Error: No assistant found with name '${name}'.`);
      console.error(`Run '${cliCommand()} ps' to see available assistants.`);
      process.exit(1);
    }
    entry = found;

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
    : await restoreAssistant({ name, dryRun });

  if (!result.ok) fail(result.error);

  if (result.kind === "recovery") {
    console.log(
      result.dryRun
        ? `Retired archive for '${name}' is ready; restore would unpack it and start the assistant. No changes were made.`
        : `✅ Recovered assistant '${name}'.`,
    );
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
}

const DESCRIPTION =
  "Restore persistent roots from tar, or recover a retired assistant";

/**
 * The `cadet restore` command — commander owns the argument and flag
 * parsing (the hand-rolled loop silently dropped a valueless `--from` and
 * fell through to recovery); this module keeps the execute layer.
 */
export function registerRestoreCommand(program: Command): void {
  program
    .command("restore")
    .description(DESCRIPTION)
    .argument(
      "<name>",
      "The assistant to restore into, or the retired assistant to recover",
    )
    .option("--from <path>", "Path to a .tar.gz backup to restore")
    .option("--dry-run", "Show what would change without applying it")
    .addHelpText(
      "after",
      `
With --from, restores all persistent roots from the archive into an existing
assistant. Without --from, recovers a retired assistant from its archive in
$XDG_DATA_HOME/cadet/retired/ and starts it again.

Examples:
  $ ${cliCommand()} restore my-retired-assistant
  $ ${cliCommand()} restore my-retired-assistant --dry-run
  $ ${cliCommand()} restore my-assistant --from backup.tar.gz
  $ ${cliCommand()} restore my-assistant --from backup.tar.gz --dry-run`,
    )
    .action(restoreFlow);
}

/**
 * Compat runner for the restore suites: the tests set process.argv and call
 * `restore()` the way the pre-commander entry did. Builds the restore
 * command standalone and parses the argv after the command word.
 */
export const restore = Object.assign(
  async function restore(): Promise<void> {
    const program = new Command();
    program.name(cliCommand());
    registerRestoreCommand(program);
    await program.parseAsync(["restore", ...process.argv.slice(3)], {
      from: "user",
    });
  },
  { description: DESCRIPTION },
);
