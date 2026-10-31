import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { platform } from "node:os";

/**
 * Process inspection and stopping for PID-tracked local services (daemon,
 * gateway, credential-executor, file watcher) and the ingress edge.
 *
 * Lives in `@mycadet/local-mode` because the lifecycle OPERATIONS stop these
 * processes in-process now (the hosts no longer spawn the CLI for them), and
 * the CLI keeps the same behavior by re-exporting this module — one stop
 * contract for every caller, with the PID-ownership proof (a stale PID file
 * whose number the OS recycled must never be killed) defined once.
 */

const CADET_COMMAND_PATTERN =
  /cadet-daemon|cadet-cli|cadet-gateway|credential-executor|@mycadet|[\\/]\.?cadet[\\/]|[\\/]daemon[\\/]main|[\\/]\.cadet[\\/].*qdrant[\\/]bin[\\/]qdrant/;

export const isCadetCommandLine = (command: string): boolean =>
  CADET_COMMAND_PATTERN.test(command);

export interface TasklistProcess {
  imageName: string;
  pid: number;
}

export function parseTasklistCsv(output: string): TasklistProcess[] {
  const processes: TasklistProcess[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^"([^"]+)","(\d+)"/);
    if (match) {
      processes.push({ imageName: match[1]!, pid: Number(match[2]) });
    }
  }
  return processes;
}

export function readWindowsProcesses(pid?: number): TasklistProcess[] {
  const args = pid
    ? ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]
    : ["/FO", "CSV", "/NH"];
  const output = execFileSync("tasklist.exe", args, {
    windowsHide: true,
    encoding: "utf-8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return parseTasklistCsv(output);
}

export function windowsCommandLineLookupArgs(pid: number): string[] {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`Invalid process ID: ${pid}`);
  }
  return [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`,
  ];
}

/** Read a process command line using the platform's process inspection tool. */
export function readProcessCommandLine(
  pid: number,
  hostPlatform: NodeJS.Platform = platform(),
): string {
  const command = hostPlatform === "win32" ? "powershell.exe" : "ps";
  const args =
    hostPlatform === "win32"
      ? windowsCommandLineLookupArgs(pid)
      : ["-p", String(pid), "-o", "command="];
  return execFileSync(command, args, {
    windowsHide: true,
    encoding: "utf8",
    timeout: 3000,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

export function isCadetWindowsProcess(
  imageName: string,
  commandLine = "",
): boolean {
  if (/^qdrant\.exe$/i.test(imageName)) {
    return isCadetCommandLine(commandLine);
  }
  if (
    /^(?:cadet|cadet-cli|cadet-daemon|cadet-gateway|credential-executor)\.exe$/i.test(
      imageName,
    )
  ) {
    return true;
  }
  return /^bun\.exe$/i.test(imageName) && isCadetCommandLine(commandLine);
}

/**
 * The POSIX command line for `pid`, or null when it cannot be read.
 *
 * Used to prove a PID still names the same process across an awaited gap. The
 * Windows path never needs it: `taskkill /T` already terminates the tree, so
 * no group escalation happens there.
 */
export function readPosixCommandLine(pid: number): string | null {
  try {
    return readProcessCommandLine(pid, platform());
  } catch {
    return null;
  }
}

/**
 * Verify that a PID belongs to a cadet-related process by inspecting its
 * command line via `ps`. Prevents killing unrelated processes when a PID file
 * is stale and the OS has reused the PID.
 */
export function isCadetProcess(
  pid: number,
  hostPlatform: NodeJS.Platform = platform(),
): boolean {
  try {
    if (hostPlatform === "win32") {
      const imageName = readWindowsProcesses(pid)[0]?.imageName ?? "";
      const commandLine = /^(?:bun|qdrant)\.exe$/i.test(imageName)
        ? readProcessCommandLine(pid, hostPlatform)
        : "";
      return isCadetWindowsProcess(imageName, commandLine);
    }
    const output = readProcessCommandLine(pid, hostPlatform);
    return isCadetCommandLine(output);
  } catch {
    return false;
  }
}

/** Discriminated union: when `alive` is true, `pid` is guaranteed non-null. */
export type ProcessAliveResult =
  | { alive: true; pid: number }
  | { alive: false; pid: null };

/**
 * Check if a PID file's process is alive.
 */
export function isProcessAlive(pidFile: string): ProcessAliveResult {
  if (!existsSync(pidFile)) {
    return { alive: false, pid: null };
  }

  try {
    const pidStr = readFileSync(pidFile, "utf-8").trim();
    const pid = parseInt(pidStr, 10);
    if (isNaN(pid)) {
      return { alive: false, pid: null };
    }

    process.kill(pid, 0);
    return { alive: true, pid };
  } catch {
    return { alive: false, pid: null };
  }
}

/** Remove one or more files, ignoring missing-file errors. */
export function removeFiles(...files: (string | string[] | undefined)[]): void {
  for (const entry of files) {
    if (!entry) continue;
    for (const f of Array.isArray(entry) ? entry : [entry]) {
      try {
        unlinkSync(f);
      } catch {}
    }
  }
}

/**
 * Stop a process by PID: SIGTERM, wait up to `timeoutMs`, then SIGKILL if still alive.
 * Returns true if the process was stopped, false if it wasn't alive or
 * termination failed.
 */
export async function stopProcess(
  pid: number,
  label: string,
  timeoutMs: number = 2000,
  hostPlatform: NodeJS.Platform = platform(),
  runTaskkill: (args: string[], timeout: number) => void = (args, timeout) => {
    execFileSync("taskkill.exe", args, {
      windowsHide: true,
      timeout,
      stdio: "ignore",
    });
  },
  readIdentity: (pid: number) => string | null = readPosixCommandLine,
  gracefulOnly = false,
): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }

  // Snapshot who this PID is before any waiting, so the group escalation below
  // can prove it is still the same process rather than a recycled PID.
  const identityBeforeWait =
    hostPlatform === "win32" ? null : readIdentity(pid);

  console.log(`Stopping ${label} (pid ${pid})...`);
  let waitForGracefulExit = true;
  if (hostPlatform === "win32") {
    if (gracefulOnly) {
      throw new Error(
        "Graceful-only shutdown is not supported for Windows local services.",
      );
    }
    try {
      runTaskkill(["/PID", String(pid), "/T"], timeoutMs);
    } catch {
      waitForGracefulExit = false;
    }
  } else {
    process.kill(pid, "SIGTERM");
  }

  const deadline = Date.now() + timeoutMs;
  while (waitForGracefulExit && Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((r) => setTimeout(r, 100));
    } catch {
      break;
    }
  }

  try {
    process.kill(pid, 0);
  } catch {
    return true;
  }
  if (gracefulOnly) return false;
  if (hostPlatform === "win32") {
    console.log(`${label} did not exit, terminating its process tree...`);
    try {
      runTaskkill(["/PID", String(pid), "/T", "/F"], timeoutMs);
    } catch {
      return false;
    }
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }
  console.log(`${label} did not exit after SIGTERM, sending SIGKILL...`);
  // Kill the process group, not just the process. Daemons are spawned
  // `detached: true` (a session and group leader), and their worker
  // subprocesses inherit that group, so a single-PID SIGKILL here is what
  // orphans workers onto init running a stale runtime. Group-kill takes the
  // whole tree at once, which is what the Windows branch above already does
  // via `taskkill /T`. Tool subprocesses run in their own groups (see
  // assistant orphan-reaper), so they are unaffected. SIGTERM above stays
  // single-PID on purpose: graceful shutdown is the daemon's to orchestrate,
  // and a group-wide SIGTERM would kill the route host mid-HTTP-drain.
  //
  // Widening a signal to a whole group demands more than liveness: the target
  // may have exited during the wait and the OS may have handed its PID to an
  // unrelated group leader. Escalate only while the command line still matches
  // the one captured before the wait; otherwise fall through to the
  // single-PID kill this function has always sent.
  const identityHolds =
    identityBeforeWait != null && readIdentity(pid) === identityBeforeWait;
  if (identityHolds) {
    try {
      process.kill(-pid, "SIGKILL");
      return true;
    } catch {
      // `pid` does not lead a group (or the group is already gone). Fall back
      // to the single-PID kill.
    }
  }
  try {
    process.kill(pid, "SIGKILL");
    return true;
  } catch (error) {
    return (
      error instanceof Error &&
      (error as NodeJS.ErrnoException).code === "ESRCH"
    );
  }
}

/**
 * Stop a process tracked by a PID file, then clean up the file.
 * Returns true if the process was stopped, false if it wasn't alive.
 */
export async function stopProcessByPidFile(
  pidFile: string,
  label: string,
  extraCleanupFiles?: string[],
  timeoutMs?: number,
  stop: (
    pid: number,
    label: string,
    timeoutMs?: number,
  ) => Promise<boolean> = stopProcess,
  ownsProcess: (pid: number) => boolean = isCadetProcess,
): Promise<boolean> {
  const { alive, pid } = isProcessAlive(pidFile);

  if (!alive || pid === null) {
    removeFiles(pidFile, extraCleanupFiles);
    return false;
  }

  // Verify the PID actually belongs to a cadet process before killing.
  // If the PID file is stale and the OS reused the PID, skip the kill
  // and clean up the stale files instead.
  if (!ownsProcess(pid)) {
    console.log(
      `PID ${pid} is not a cadet process — cleaning up stale ${label} PID file.`,
    );
    removeFiles(pidFile, extraCleanupFiles);
    return false;
  }

  const stopped = await stop(pid, label, timeoutMs);
  if (stopped || !isProcessAlive(pidFile).alive) {
    removeFiles(pidFile, extraCleanupFiles);
  }
  return stopped;
}
