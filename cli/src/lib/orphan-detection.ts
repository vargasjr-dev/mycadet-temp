import { existsSync, readFileSync } from "fs";
import { join } from "path";

import {
  getDaemonPidPath,
  isLocalInstanceResources,
  loadAllAssistantsAcrossEnvs,
  type LockfileAssistant,
} from "./assistant-config.js";
import { execOutput } from "./step-runner";

export interface RemoteProcess {
  pid: string;
  ppid: string;
  command: string;
}

const CADET_PROCESS_MARKER = /cadet|qdrant/;

export function classifyProcess(command: string): string {
  if (/qdrant/.test(command)) return "qdrant";
  if (/cadet-gateway/.test(command)) return "gateway";
  if (/cadet-daemon|[\\/]daemon[\\/]main/.test(command)) return "assistant";
  if (/daemon\s+(start|restart)/.test(command)) return "assistant";
  if (/(?:cadet)-cli|[\\/](?:cadet)(?:-cli)?\.exe/.test(command))
    return "cadet";
  // Exclude macOS desktop app processes — their path contains .app/Contents/MacOS/
  // but they are not background service processes.
  if (/\.app\/Contents\/MacOS\//.test(command)) return "unknown";
  // Match cadet CLI commands (e.g. "cadet hatch", "cadet sleep") but NOT
  // unrelated processes whose working directory or repo path happens to contain
  // e.g. /Users/runner/work/mycadet/mycadet/... repo
  // checkouts must not classify as the cadet CLI.
  if (/(?:^|\/)cadet(?:\s|$)/.test(command)) return "cadet";
  return "unknown";
}

/**
 * True when the command line is a deliberate long-running interactive CLI
 * session (e.g. a live `cadet tunnel` in someone's terminal). Such sessions
 * have no PID-file registration, so `cadet clean` would otherwise kill them
 * mid-session. The command line may be "bun /path/to/bin/cadet tunnel ...",
 * so match the subcommand right after the cadet binary/script path (allowing
 * only the known global flags in between; see GLOBAL_FLAGS in cli/src/index.ts).
 * Later argv tokens (e.g. "cadet hatch --name logs") must not match.
 *
 * `detectOrphanedProcesses` consults this before classification so that
 * service-like substrings in later argv (e.g. `cadet exec -it --service
 * cadet-gateway -- /bin/sh`) cannot re-flag a live session, while
 * `classifyProcess` stays a pure display label for `cadet ps`.
 *
 * Also spared: bare `cadet` (no subcommand launches the implicit TUI client
 * via tryLaunchClient) and `cadet wake --foreground` (stays attached with
 * logs in the terminal).
 */
export function isInteractiveCliSession(command: string): boolean {
  const cadetToken =
    /(?:^|[\\/])cadet(?:-cli)?(?:\.exe)?["']?(?:\s+--(?:no-color|plain))*/;
  const interactiveSubcommand = new RegExp(
    cadetToken.source +
      String.raw`\s+(?:tunnel|events|logs|client|terminal|ssh|exec|message|workflows)\b`,
  );
  const implicitTuiClient = new RegExp(cadetToken.source + String.raw`\s*$`);
  const foregroundWake = new RegExp(
    cadetToken.source + String.raw`\s+wake\b(?:\s+\S+)*\s--foreground\b`,
  );
  return (
    interactiveSubcommand.test(command) ||
    implicitTuiClient.test(command) ||
    foregroundWake.test(command)
  );
}

export function parseRemotePs(output: string): RemoteProcess[] {
  return output
    .trim()
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const trimmed = line.trim();
      const parts = trimmed.split(/\s+/);
      const pid = parts[0];
      const ppid = parts[1];
      const command = parts.slice(2).join(" ");
      return { pid, ppid, command };
    });
}

export function readPidFile(pidFile: string): string | null {
  if (!existsSync(pidFile)) return null;
  const pid = readFileSync(pidFile, "utf-8").trim();
  return pid || null;
}

export function isPidAlive(pid: string): boolean {
  try {
    process.kill(parseInt(pid, 10), 0);
    return true;
  } catch {
    return false;
  }
}

export interface OrphanedProcess {
  name: string;
  pid: string;
  source: string;
}

/**
 * Collect PIDs that belong to a known assistant in any environment.
 *
 * For local entries this reads the daemon/gateway/qdrant/embed-worker PID
 * files under each entry's `instanceDir`. For docker entries we include the
 * `watcherPid` field when present (the file watcher runs as a host process,
 * unlike the containers themselves). Other cloud topologies don't have
 * host-side processes that show up in `ps ax`.
 *
 * This set is the basis for filtering the orphan list: if a running process
 * matches a recorded PID for *any* env's assistant, it's not an orphan.
 */
export function getKnownPidsFromAssistants(
  entries: LockfileAssistant[],
): Set<string> {
  const pids = new Set<string>();
  for (const entry of entries) {
    if (entry.cloud === "local" && isLocalInstanceResources(entry.resources)) {
      const stateDir = entry.resources.instanceDir;
      const candidates = [
        getDaemonPidPath(entry.resources),
        join(stateDir, "gateway.pid"),
        join(stateDir, "workspace", "data", "qdrant", "qdrant.pid"),
        join(stateDir, "workspace", "embed-worker.pid"),
      ];
      for (const file of candidates) {
        const pid = readPidFile(file);
        if (pid) pids.add(pid);
      }
    }
    if (typeof entry.watcherPid === "number") {
      pids.add(String(entry.watcherPid));
    }
  }
  return pids;
}

export interface DetectOrphansOptions {
  /**
   * Set of PIDs to treat as known and exclude from the orphan list. When
   * omitted, defaults to the union of every env's recorded assistant PIDs
   * via {@link loadAllAssistantsAcrossEnvs} +
   * {@link getKnownPidsFromAssistants}. Tests can inject an explicit set to
   * avoid touching the real on-host lockfiles.
   */
  excludePids?: Set<string>;
  platform?: NodeJS.Platform;
}

const WINDOWS_PROCESS_LIST_SCRIPT =
  'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.CommandLine)" }';

export function processTableCommand(hostPlatform: NodeJS.Platform): {
  command: string;
  args: string[];
} {
  if (hostPlatform === "win32") {
    return {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        WINDOWS_PROCESS_LIST_SCRIPT,
      ],
    };
  }
  return { command: "ps", args: ["ax", "-o", "pid=,ppid=,args="] };
}

export async function detectOrphanedProcesses(
  options: DetectOrphansOptions = {},
): Promise<OrphanedProcess[]> {
  const results: OrphanedProcess[] = [];
  const seenPids = new Set<string>();

  // PIDs that belong to a known assistant in *any* environment are not
  // orphans. Without this filter, running `cadet ps` from an env that has
  // no assistants — or `cadet clean` from any env — would flag (or kill)
  // another env's healthy services as orphans.
  const knownPids =
    options.excludePids ??
    getKnownPidsFromAssistants(loadAllAssistantsAcrossEnvs());

  // Process table scan — discover orphaned processes by scanning the OS
  // process table rather than reading PID files from the workspace.
  try {
    const table = processTableCommand(options.platform ?? process.platform);
    const output = await execOutput(table.command, table.args, {
      timeoutMs: 5_000,
    });
    const procs = parseRemotePs(output);
    const ownPid = String(process.pid);

    for (const p of procs) {
      if (p.pid === ownPid || seenPids.has(p.pid)) continue;
      if (knownPids.has(p.pid)) continue;
      if (!CADET_PROCESS_MARKER.test(p.command)) continue;
      // Live interactive sessions are spared before classification so that
      // service substrings in their argv cannot mark them as orphans.
      if (isInteractiveCliSession(p.command)) {
        continue;
      }
      const type = classifyProcess(p.command);
      if (type === "unknown") continue;
      results.push({ name: type, pid: p.pid, source: "process table" });
      seenPids.add(p.pid);
    }
  } catch {
    // grep exits 1 when no matches found — ignore
  }

  return results;
}
