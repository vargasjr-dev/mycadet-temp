import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";

import {
  CLOCK_TICKS_PER_SECOND,
  parseProcStat,
  readKernelPageSizeBytes,
} from "../monitoring/proc-wait-state.js";

const execFileAsync = promisify(execFile);

export interface ProcessResources {
  /** Percentage of one CPU core; may exceed 100 for multithreaded processes. */
  cpuPct?: number;
  /** Resident bytes, not virtual address space. */
  rssBytes?: number;
}

interface Counters {
  cpuSeconds: number;
  identity: string;
  rssBytes: number;
}

/** ps TIME is [[days-]hours:]minutes:seconds, with optional fractions. */
export function parseCpuTime(value: string): number {
  const [days, clock] = value.includes("-") ? value.split("-") : ["0", value];
  return (
    Number(days) * 86400 +
    clock.split(":").reduce((n, part) => n * 60 + Number(part), 0)
  );
}

async function readCounters(pids: number[]): Promise<Map<number, Counters>> {
  const counters = new Map<number, Counters>();
  if (process.platform === "linux") {
    const pageSize = readKernelPageSizeBytes();
    for (const pid of pids) {
      try {
        const stat = parseProcStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
        if (stat) {
          counters.set(pid, {
            cpuSeconds: stat.cpuTicks / CLOCK_TICKS_PER_SECOND,
            identity: String(stat.startTicks),
            rssBytes: stat.rssPages * pageSize,
          });
        }
      } catch {
        // Exited or unreadable; do not turn missing data into zero usage.
      }
    }
  } else if (process.platform === "win32") {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Get-Process -Id ${pids.join(",")} -ErrorAction SilentlyContinue | ForEach-Object { \"$($_.Id) $($_.CPU.ToString([Globalization.CultureInfo]::InvariantCulture)) $($_.WorkingSet64) $($_.StartTime.ToFileTimeUtc())\" }`,
      ],
      { windowsHide: true, timeout: 3000, maxBuffer: 1024 * 1024 },
    );
    for (const line of stdout.trim().split("\n")) {
      const match = /^(\d+)\s+([\d.]+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
      if (match) {
        counters.set(Number(match[1]), {
          cpuSeconds: Number(match[2]),
          rssBytes: Number(match[3]),
          identity: match[4],
        });
      }
    }
  } else {
    const { stdout } = await execFileAsync(
      "ps",
      ["-p", pids.join(","), "-o", "pid=,time=,rss=,lstart="],
      { windowsHide: true, timeout: 3000, maxBuffer: 1024 * 1024 },
    );
    for (const line of stdout.split("\n")) {
      const match = /^\s*(\d+)\s+([\d:.-]+)\s+(\d+)\s+(.+)$/.exec(line);
      if (match) {
        counters.set(Number(match[1]), {
          cpuSeconds: parseCpuTime(match[2]),
          rssBytes: Number(match[3]) * 1024,
          identity: match[4].trim(),
        });
      }
    }
  }
  return counters;
}

/** Two fresh samples keep even the first `assistant ps` useful. No polling timer. */
export async function sampleProcessResources(
  pids: number[],
): Promise<Map<number, ProcessResources>> {
  if (pids.length === 0) {
    return new Map();
  }
  try {
    const before = await readCounters(pids);
    const startedAt = performance.now();
    await setTimeout(200);
    const after = await readCounters(pids);
    const elapsedSeconds = (performance.now() - startedAt) / 1000;
    return new Map(
      [...after].map(([pid, current]) => {
        const previous = before.get(pid);
        return [
          pid,
          {
            rssBytes: current.rssBytes,
            ...(previous?.identity === current.identity && elapsedSeconds > 0
              ? {
                  cpuPct: Math.max(
                    0,
                    ((current.cpuSeconds - previous.cpuSeconds) /
                      elapsedSeconds) *
                      100,
                  ),
                }
              : {}),
          },
        ];
      }),
    );
  } catch {
    return new Map();
  }
}
