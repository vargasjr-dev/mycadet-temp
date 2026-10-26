import { spawn } from "child_process";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "fs";
import { basename, dirname, join, win32 } from "path";

import {
  getDaemonPidPath,
  getLocalInstanceDir,
  loadAllAssistants,
} from "./assistant-config.js";
import type { LockfileAssistant } from "./assistant-config.js";
import { stopIngressNginx } from "./nginx-ingress.js";
import { getKnownPidsFromAssistants } from "./orphan-detection.js";
import {
  DAEMON_STOP_TIMEOUT_MS,
  stopOrphanedDaemonProcesses,
  stopProcessByPidFile,
} from "./process.js";
import { getArchivePath, getMetadataPath } from "./retire-archive.js";
import {
  consoleLifecycleReporter,
  type LifecycleReporter,
} from "./lifecycle-reporter.js";

export interface RetireLocalResult {
  assistantId: string;
  /** Whether the instance data directory was archived (false when skipped). */
  archived: boolean;
  /** Path to the background tar archive, when archiving was started. */
  archivePath?: string;
  /** True when another local assistant shared the data dir, so it was kept. */
  sharedDataDir?: boolean;
}

interface RetireArchiveCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

const WINDOWS_RETIRE_ARCHIVE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "& tar.exe -czf $env:CADET_RETIRE_ARCHIVE_PATH -C $env:CADET_RETIRE_ARCHIVE_PARENT $env:CADET_RETIRE_STAGING_NAME",
  "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
  "Remove-Item -LiteralPath $env:CADET_RETIRE_STAGING_DIR -Recurse -Force",
].join("; ");

export function getRetireArchiveCommand(
  archivePath: string,
  stagingDir: string,
  hostPlatform: NodeJS.Platform = process.platform,
): RetireArchiveCommand {
  const archiveParent =
    hostPlatform === "win32" ? win32.dirname(stagingDir) : dirname(stagingDir);
  const stagingName =
    hostPlatform === "win32"
      ? win32.basename(stagingDir)
      : basename(stagingDir);
  if (hostPlatform === "win32") {
    return {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        WINDOWS_RETIRE_ARCHIVE_SCRIPT,
      ],
      env: {
        CADET_RETIRE_ARCHIVE_PATH: archivePath,
        CADET_RETIRE_ARCHIVE_PARENT: archiveParent,
        CADET_RETIRE_STAGING_NAME: stagingName,
        CADET_RETIRE_STAGING_DIR: stagingDir,
      },
    };
  }
  return {
    command: "sh",
    args: [
      "-c",
      'tar czf "$1" -C "$2" "$3" && rm -rf "$4"',
      "cadet-retire",
      archivePath,
      archiveParent,
      stagingName,
      stagingDir,
    ],
  };
}

export async function retireLocal(
  name: string,
  entry: LockfileAssistant,
  reporter: LifecycleReporter = consoleLifecycleReporter,
): Promise<RetireLocalResult> {
  reporter.log("\u{1F5D1}\ufe0f  Stopping local assistant...\n");

  if (!entry.resources) {
    throw new Error(
      `Local assistant '${name}' is missing resource configuration. Re-hatch to fix.`,
    );
  }
  const resources = entry.resources;
  const cadetDir = getLocalInstanceDir(resources);

  // Check whether another local assistant shares the same data directory.
  const otherSharesDir = loadAllAssistants().some((other) => {
    if (other.cloud !== "local") return false;
    if (other.assistantId === name) return false;
    if (!other.resources) return false;
    const otherCadetDir = other.resources.instanceDir;
    return otherCadetDir === cadetDir;
  });

  if (otherSharesDir) {
    reporter.log(
      `   Skipping process stop and archive — another local assistant shares ${cadetDir}.`,
    );
    reporter.log("\u2705 Local instance retired (config entry removed only).");
    return { assistantId: name, archived: false, sharedDataDir: true };
  }

  const daemonPidFile = getDaemonPidPath(resources);
  const daemonStopped = await stopProcessByPidFile(
    daemonPidFile,
    "daemon",
    undefined,
    DAEMON_STOP_TIMEOUT_MS,
  );

  // Stop gateway via PID file — use a longer timeout because the gateway has a
  // drain window (5s) before it exits.
  await stopProcessByPidFile(
    join(cadetDir, "gateway.pid"),
    "gateway",
    undefined,
    7000,
  );

  // Stop the CES sibling — it is stopped by its PID file, a no-op when the
  // PID file is absent (e.g. the sibling was never started or already exited).
  await stopProcessByPidFile(join(cadetDir, "ces.pid"), "credential-executor");

  // Stop the nginx ingress if one is fronting this gateway — it would
  // otherwise be orphaned when the instance directory is archived.
  await stopIngressNginx(join(cadetDir, "workspace"));

  // If the PID file didn't track a running daemon, scan for orphaned
  // daemon processes that may have been started without writing a PID.
  if (!daemonStopped) {
    const otherAssistantPids = getKnownPidsFromAssistants(
      loadAllAssistants().filter(
        (other) =>
          other.assistantId !== name ||
          other.resources?.instanceDir !== resources.instanceDir,
      ),
    );
    await stopOrphanedDaemonProcesses(otherAssistantPids);
  }

  // Archive and remove the entire instance directory.
  const dirToArchive = getLocalInstanceDir(resources);

  // Move the data directory out of the way so the path is immediately available
  // for the next hatch, then kick off the tar archive in the background.
  const archivePath = getArchivePath(name);
  const metadataPath = getMetadataPath(name);
  const stagingDir = `${archivePath}.staging`;

  if (!existsSync(dirToArchive)) {
    reporter.log(
      `   No data directory at ${dirToArchive} — nothing to archive.`,
    );
    reporter.log("\u2705 Local instance retired.");
    return { assistantId: name, archived: false };
  }

  // Ensure the retired archive directory exists before attempting the rename
  mkdirSync(dirname(stagingDir), { recursive: true });

  try {
    renameSync(dirToArchive, stagingDir);
  } catch (err) {
    // Re-throw so the caller (and the desktop app) knows the archive failed.
    // If the rename fails, old workspace data stays in place and a subsequent
    // hatch would inherit stale SOUL.md, IDENTITY.md, and memories.
    throw new Error(
      `Failed to archive ${dirToArchive}: ${err instanceof Error ? err.message : err}`,
    );
  }

  writeFileSync(metadataPath, JSON.stringify(entry, null, 2) + "\n");

  // Spawn tar + cleanup in the background and detach so the CLI can exit
  // immediately. The staging directory is removed once the archive is written.
  const archiveCommand = getRetireArchiveCommand(archivePath, stagingDir);
  const child = spawn(archiveCommand.command, archiveCommand.args, {
    stdio: "ignore",
    detached: true,
    windowsHide: true,
    ...(archiveCommand.env
      ? { env: { ...process.env, ...archiveCommand.env } }
      : {}),
  });
  child.unref();

  reporter.log(`📦 Archiving to ${archivePath} in the background.`);
  reporter.log("\u2705 Local instance retired.");

  return { assistantId: name, archived: true, archivePath };
}
