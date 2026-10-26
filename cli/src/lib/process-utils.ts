import { existsSync, readFileSync } from "fs";

export interface RemoteProcess {
  pid: string;
  ppid: string;
  command: string;
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
