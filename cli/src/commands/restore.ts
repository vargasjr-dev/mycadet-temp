import { isCloudHome } from "../lib/cloud-values.js";
import { cliCommand } from "../lib/cli-name.js";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  renameSync,
  unlinkSync,
} from "fs";
import { basename, dirname, join } from "path";

import { resolveExistingLocalSigningKey } from "@mycadet/local-mode";
import {
  findAssistantByName,
  saveLockfileAssistant,
} from "../lib/assistant-config.js";
import type { LockfileAssistant } from "../lib/assistant-config.js";
import {
  generateLocalSigningKey,
  startCes,
  startLocalDaemon,
  startGateway,
} from "../lib/local.js";
import { getArchivePath, getMetadataPath } from "../lib/retire-archive.js";
import { exec } from "../lib/step-runner.js";
import {
  readCloudToken,
  cloudRequestSignedUrl,
  platformUploadToSignedUrl,
  platformImportPreflightFromGcs,
  platformImportBundleFromGcs,
  platformPollJobStatus,
} from "../lib/cloud-client.js";
import { restoreRootBackup, validateRootArchive } from "../lib/root-backup.js";

function printUsage(): void {
  console.log(`Usage: ${cliCommand()} restore <name> [--from <path>] [--dry-run]`);
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
  console.log(`  ${cliCommand()} restore my-cloud-assistant --from backup.tar.gz`);
  console.log(`  ${cliCommand()} restore my-assistant --from backup.tar.gz --dry-run`);
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

interface PreflightFileEntry {
  path: string;
  action: string;
}

interface StructuredError {
  code: string;
  message: string;
  path?: string;
}

interface PreflightResponse {
  can_import: boolean;
  validation?: {
    is_valid: false;
    errors: StructuredError[];
  };
  files?: PreflightFileEntry[];
  summary?: {
    files_to_create: number;
    files_to_overwrite: number;
    files_unchanged: number;
    total_files: number;
  };
  conflicts?: StructuredError[];
}

interface ImportResponse {
  success: boolean;
  reason?: string;
  errors?: StructuredError[];
  message?: string;
  warnings?: string[];
  summary?: {
    total_files: number;
    files_created: number;
    files_overwritten: number;
    files_skipped: number;
    backups_created: number;
  };
}

// ---------------------------------------------------------------------------
// Cloud restore through the cloud API; the CLI never opens cloud storage.
// ---------------------------------------------------------------------------

async function restorePlatform(
  entry: LockfileAssistant,
  name: string,
  bundleData: Buffer,
  opts: { dryRun: boolean },
): Promise<void> {
  // Step 1 — Authenticate
  const token = readCloudToken();
  if (!token) {
    console.error(`Not logged in. Run '${cliCommand()} login' first.`);
    process.exit(1);
  }

  // Upload the root archive through the cloud API; it owns cloud restore.
  const { url: uploadUrl, bundleKey } = await cloudRequestSignedUrl(
    {
      operation: "upload",
      contentType: "application/gzip",
      contentLength: bundleData.length,
    },
    token,
    entry.runtimeUrl,
  );
  console.log("Uploading bundle...");
  await platformUploadToSignedUrl(uploadUrl, new Uint8Array(bundleData));

  // Step 2 — Dry-run path
  if (opts.dryRun) {
    console.log("Running preflight analysis...\n");

    let preflightResult: { statusCode: number; body: Record<string, unknown> };
    try {
      preflightResult = await platformImportPreflightFromGcs(
        bundleKey,
        token,
        entry.runtimeUrl,
      );
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        console.error("Error: Preflight request timed out after 30 minutes.");
        process.exit(1);
      }
      throw err;
    }

    if (
      preflightResult.statusCode === 401 ||
      preflightResult.statusCode === 403
    ) {
      console.error(`Authentication failed. Run '${cliCommand()} login' to refresh.`);
      process.exit(1);
    }

    if (preflightResult.statusCode === 404) {
      console.error(
        "No cloud assistant found. Ensure your assistant is running.",
      );
      process.exit(1);
    }

    if (preflightResult.statusCode === 409) {
      console.error(
        "Multiple assistants found. This is a Cadet Cloud configuration issue.",
      );
      process.exit(1);
    }

    if (
      preflightResult.statusCode === 502 ||
      preflightResult.statusCode === 503 ||
      preflightResult.statusCode === 504
    ) {
      console.error(
        `Assistant is unreachable. Try 'cadet wake ${name}' first.`,
      );
      process.exit(1);
    }

    if (preflightResult.statusCode !== 200) {
      console.error(
        `Error: Preflight check failed (${preflightResult.statusCode}): ${JSON.stringify(preflightResult.body)}`,
      );
      process.exit(1);
    }

    const result = preflightResult.body as unknown as PreflightResponse;

    if (!result.can_import) {
      if (result.validation?.errors?.length) {
        console.error("Import blocked by validation errors:");
        for (const err of result.validation.errors) {
          console.error(
            `  - ${err.message}${err.path ? ` (${err.path})` : ""}`,
          );
        }
      }
      if (result.conflicts?.length) {
        console.error("Import blocked by conflicts:");
        for (const conflict of result.conflicts) {
          console.error(
            `  - ${conflict.message}${conflict.path ? ` (${conflict.path})` : ""}`,
          );
        }
      }
      process.exit(1);
    }

    // Print summary table
    const summary = result.summary ?? {
      files_to_create: 0,
      files_to_overwrite: 0,
      files_unchanged: 0,
      total_files: 0,
    };
    console.log("Preflight analysis:");
    console.log(`  Files to create:    ${summary.files_to_create}`);
    console.log(`  Files to overwrite: ${summary.files_to_overwrite}`);
    console.log(`  Files unchanged:    ${summary.files_unchanged}`);
    console.log(`  Total:              ${summary.total_files}`);
    console.log("");

    const conflicts = result.conflicts ?? [];
    console.log(
      `Conflicts: ${conflicts.length > 0 ? conflicts.map((c) => c.message).join(", ") : "none"}`,
    );

    // List individual files with their action
    if (result.files && result.files.length > 0) {
      console.log("");
      console.log("Files:");
      for (const file of result.files) {
        console.log(`  [${file.action}] ${file.path}`);
      }
    }

    return;
  }

  // Step 4 — Data import
  console.log("Importing backup data...");

  let importResult: { statusCode: number; body: Record<string, unknown> };
  try {
    importResult = await platformImportBundleFromGcs(
      bundleKey,
      token,
      entry.runtimeUrl,
    );
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      console.error("Error: Import request timed out after 30 minutes.");
      process.exit(1);
    }
    throw err;
  }

  if (importResult.statusCode === 401 || importResult.statusCode === 403) {
    console.error(`Authentication failed. Run '${cliCommand()} login' to refresh.`);
    process.exit(1);
  }

  if (importResult.statusCode === 404) {
    console.error(
      "No cloud assistant found. Ensure your assistant is running.",
    );
    process.exit(1);
  }

  if (importResult.statusCode === 409) {
    console.error(
      "Multiple assistants found. This is a Cadet Cloud configuration issue.",
    );
    process.exit(1);
  }

  if (
    importResult.statusCode === 502 ||
    importResult.statusCode === 503 ||
    importResult.statusCode === 504
  ) {
    console.error(`Assistant is unreachable. Try 'cadet wake ${name}' first.`);
    process.exit(1);
  }

  if (
    importResult.statusCode !== 202 &&
    (importResult.statusCode < 200 || importResult.statusCode >= 300)
  ) {
    console.error(`Error: Import failed (${importResult.statusCode})`);
    process.exit(1);
  }

  // Async import — poll until complete
  if (importResult.statusCode === 202) {
    const jobId = (importResult.body as { job_id?: string }).job_id;
    if (!jobId) {
      console.error("Error: Import accepted but no job ID returned.");
      process.exit(1);
    }

    const POLL_INTERVAL_MS = 5_000;
    const TIMEOUT_MS = 10 * 60 * 1_000; // 10 minutes
    const startTime = Date.now();
    const deadline = startTime + TIMEOUT_MS;

    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

      let status: Awaited<ReturnType<typeof platformPollJobStatus>>;
      try {
        status = await platformPollJobStatus(jobId, token, entry.runtimeUrl);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("not found")) {
          throw err;
        }
        // Fail fast on auth errors from authHeaders() which don't
        // match the "status check failed: NNN" format
        if (msg.includes("401") || msg.includes("403")) {
          throw err;
        }
        // Re-throw permanent 4xx errors, retry transient 5xx
        const statusMatch = msg.match(/status check failed: (\d+)/);
        if (statusMatch) {
          const statusCode = parseInt(statusMatch[1], 10);
          if (statusCode >= 400 && statusCode < 500) {
            throw err;
          }
        }
        // Transient error (5xx, network) — retry
        console.warn(`Polling failed: ${msg}. Retrying...`);
        continue;
      }

      if (status.status === "complete") {
        importResult = {
          statusCode: 200,
          body: (status.result as Record<string, unknown>) ?? {},
        };
        break;
      }

      if (status.status === "failed") {
        console.error(`Import failed: ${status.error ?? "unknown error"}`);
        process.exit(1);
      }

      const elapsed = Math.round((Date.now() - startTime) / 1000);
      process.stdout.write(`\rImporting... ${elapsed}s elapsed`);
    }

    // Clear the progress line
    process.stdout.write("\r" + " ".repeat(40) + "\r");

    if (importResult.statusCode === 202) {
      console.error("Import timed out after 10 minutes.");
      process.exit(1);
    }
  }

  const result = importResult.body as unknown as ImportResponse;

  if (!result.success) {
    console.error(
      `Error: Import failed — ${result.message ?? result.reason ?? "unknown reason"}`,
    );
    for (const err of result.errors ?? []) {
      console.error(`  - ${err.message}${err.path ? ` (${err.path})` : ""}`);
    }
    process.exit(1);
  }

  // Print import report
  const summary = result.summary ?? {
    total_files: 0,
    files_created: 0,
    files_overwritten: 0,
    files_skipped: 0,
    backups_created: 0,
  };
  console.log("✅ Restore complete.");
  console.log(`  Files created:     ${summary.files_created}`);
  console.log(`  Files overwritten: ${summary.files_overwritten}`);
  console.log(`  Files skipped:     ${summary.files_skipped}`);
  console.log(`  Backups created:   ${summary.backups_created}`);

  // Print warnings if any
  const warnings = result.warnings ?? [];
  if (warnings.length > 0) {
    console.log("");
    console.log("Warnings:");
    for (const warning of warnings) {
      console.log(`  ⚠️  ${warning}`);
    }
  }
}

/**
 * Recover a previously retired local assistant from its archive: extract the
 * archived workspace data back to its original location, restore the lockfile
 * entry, and start the assistant and gateway. Archives live in
 * $XDG_DATA_HOME/cadet/retired/ (default: ~/.local/share/cadet/retired/).
 */
async function recoverFromArchive(name: string): Promise<void> {
  const archivePath = getArchivePath(name);
  const metadataPath = getMetadataPath(name);

  // Verify the archive exists
  if (!existsSync(archivePath) || !existsSync(metadataPath)) {
    console.error(`No retired archive found for '${name}'.`);
    process.exit(1);
  }

  // Read and validate metadata before any side effects
  const entry: LockfileAssistant = JSON.parse(readFileSync(metadataPath, "utf-8"));
  if (!entry.resources) {
    throw new Error(
      `Retired assistant '${name}' is missing resource configuration. ` +
        `Fix the archive metadata at ${metadataPath} and retry, ` +
        `or run 'cadet hatch' to re-provision with proper resource allocation.`,
    );
  }

  // Check that the recovering entry's own target directory is free.
  const target = entry.resources.instanceDir;
  if (existsSync(target)) {
    console.error(
      `Error: ${target} already exists (owned by ${entry.assistantId}). ` +
        `Retire the current assistant first.`,
    );
    process.exit(1);
  }

  // Extract and rename.
  //
  // retireLocal archives the full instanceDir. The directory is staged under
  // `<archive>.staging` inside the retired dir before being packed with
  // `tar -C <retiredDir> <stagingBasename>`, so the top-level entry inside
  // the tarball is always `<name>.tar.gz.staging`.
  //
  // Correct restoration: extract to retiredDir, then rename the staging entry
  // back to the original target path. Using homedir() as the -C target was
  // wrong for any instance stored outside the home directory.
  const targetDir = entry.resources.instanceDir;
  const retiredDir = dirname(archivePath);
  const extractedPath = join(retiredDir, basename(archivePath) + ".staging");

  await exec("tar", ["xzf", archivePath, "-C", retiredDir]);
  // Validate the staged identity before occupying the destination or updating
  // the registry. A failed validation leaves the archive available for retry.
  const signingKey = resolveExistingLocalSigningKey(
    entry.resources,
    extractedPath,
  );
  const bootstrapSecret =
    entry.guardianBootstrapSecret ?? generateLocalSigningKey();
  entry.resources = { ...entry.resources, signingKey };
  entry.guardianBootstrapSecret = bootstrapSecret;
  mkdirSync(dirname(targetDir), { recursive: true });
  renameSync(extractedPath, targetDir);
  saveLockfileAssistant(entry);

  // Start CES sibling + daemon + gateway in parallel, the way the
  // Docker topology brings its sibling processes up together. startCes
  // always launches the CES sibling.
  await Promise.all([
    startCes(false, entry.resources),
    startLocalDaemon(false, entry.resources, { signingKey }),
    startGateway(false, entry.resources, { signingKey, bootstrapSecret }),
  ]);

  unlinkSync(archivePath);
  unlinkSync(metadataPath);

  console.log(`✅ Recovered assistant '${name}'.`);
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
    if (!fromPath) {
      if (dryRun) {
        console.error(
          "Dry-run is only supported with --from. Recovery replays the retired assistant's archive directly.",
        );
        process.exit(1);
      }
      await recoverFromArchive(name);
      return;
    }

    // Look up the instance
    const entry = findAssistantByName(name);
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

    const cloud = entry.cloud;

    if (cloud === "apple-container") {
      console.error(
        `Error: '${name}' uses the Apple Containers runtime. Restore is not yet supported for this topology.`,
      );
      process.exit(1);
    }

    if (isCloudHome(cloud)) {
      await validateRootArchive(fromPath);
      const bundleData = readFileSync(fromPath);
      await restorePlatform(entry, name, bundleData, { dryRun });
      return;
    }

    if (cloud !== "local" && cloud !== "docker") {
      throw new Error(`Restore for '${cloud}' must run on its host.`);
    }
    const recoveryPath = await restoreRootBackup(entry, fromPath, { dryRun });
    if (dryRun)
      console.log(
        "Root archive is valid; restore would replace workspace, gateway security, CES security and CES data. No services were stopped.",
      );
    else {
      console.log("Restore complete.");
      console.log(`Previous state retained at ${recoveryPath}`);
    }
  },
  {
    description:
      "Restore persistent roots from tar, or recover a retired assistant",
  },
);
