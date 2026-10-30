import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

import { resolveLogDir } from "@mycadet/local-mode";

import { getLocalInstanceDir } from "./assistant-config.js";
import type { LocalAssistantResources } from "@mycadet/local-mode";
import { promptLine } from "./provider-secrets.js";
import type { LifecycleReporter } from "./lifecycle-reporter.js";

/**
 * Failure handling for local startup (`cadet hatch`).
 *
 * A failed hatch used to surface as a single thrown message ("did not bind
 * its local port", "socket did not appear") with no pointer to the log files
 * that hold the actual cause — and those logs live in three different places.
 * These helpers list the logs a hatch attempt wrote, scan them for a likely
 * cause, and (on an interactive terminal) prompt the operator for which log
 * to view inline. Everything here is best effort: a diagnostic failure must
 * never mask the original startup error.
 */

/** One service log a local hatch writes to. */
export interface StartupServiceLog {
  /** Human-facing service name, e.g. "assistant". */
  service: string;
  /** File the service's stdout/stderr was piped into. */
  path: string;
}

/**
 * The log files a local hatch attempt writes to, in prompt order. The
 * assistant daemon and gateway pipe into per-instance files
 * (openRuntimeLogFile); the credential-executor shares the session-wide
 * hatch.log (openLogFile), which also holds the CLI-side startup lines.
 */
export function collectStartupServiceLogs(
  resources?: LocalAssistantResources,
): StartupServiceLog[] {
  const instanceLogsDir = join(getLocalInstanceDir(resources), "logs");
  return [
    {
      service: "assistant",
      path: join(instanceLogsDir, "assistant-stdout.log"),
    },
    {
      service: "credential-executor",
      path: join(resolveLogDir(), "hatch.log"),
    },
    {
      service: "gateway",
      path: join(instanceLogsDir, "gateway-stdout.log"),
    },
  ];
}

/** How far back into a log the tail reads, so a runaway log can't stall
 * failure handling. Hatch logs reset per session, so this is generous. */
const TAIL_READ_BYTES = 512 * 1024;

/** Last `maxLines` non-blank lines of a file, or [] when unreadable. */
export function tailLines(filePath: string, maxLines: number): string[] {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile() || stat.size === 0) return [];
    const readBytes = Math.min(stat.size, TAIL_READ_BYTES);
    const fd = openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(readBytes);
      readSync(fd, buffer, 0, readBytes, stat.size - readBytes);
      return buffer
        .toString("utf-8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .slice(-maxLines);
    } finally {
      closeSync(fd);
    }
  } catch {
    return [];
  }
}

interface FailurePattern {
  pattern: RegExp;
  hint: string;
}

/** Ordered most-specific first; a log line stops at the first match. */
const FAILURE_PATTERNS: FailurePattern[] = [
  {
    pattern: /EADDRINUSE|address already in use|WSAEADDRINUSE/i,
    hint:
      "A port this service needs is already in use — stop the other process " +
      "or let hatch allocate a different port.",
  },
  {
    pattern: /EACCES|EPERM|permission denied|access is denied/i,
    hint:
      "Permission denied — on Windows this is often a reserved port range " +
      "(`netsh interface ipv4 show excludedportrange protocol=tcp`), " +
      "antivirus, or folder permissions on the instance directory.",
  },
  {
    pattern: /ECONNREFUSED|connection refused/i,
    hint:
      "A connection was refused — a sibling service may have failed before " +
      "this one came up.",
  },
  {
    pattern: /SQLITE_CANTOPEN|database is locked|SQLITE_BUSY/i,
    hint: "The instance database could not be opened or is locked.",
  },
  {
    pattern: /ENOENT|no such file or directory/i,
    hint:
      "A file or directory this service needs was not found — check the " +
      "paths in the matched log line.",
  },
  {
    pattern: /ETIMEDOUT|timed out/i,
    hint:
      "An operation timed out — a sibling service may not have come up in " +
      "time.",
  },
];

/** A likely-cause hint, with the log line that produced it. */
export interface StartupFailureHint {
  hint: string;
  line: string;
}

/** Match log tail lines against known failure patterns, newest first. */
export function detectStartupFailureHints(
  lines: string[],
): StartupFailureHint[] {
  const hints: StartupFailureHint[] = [];
  const seen = new Set<string>();
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    for (const { pattern, hint } of FAILURE_PATTERNS) {
      if (pattern.test(line)) {
        if (!seen.has(hint)) {
          seen.add(hint);
          hints.push({ hint, line });
        }
        break;
      }
    }
    if (hints.length >= 3) break;
  }
  return hints;
}

/** How many tail lines an interactive log view shows. */
const VIEW_TAIL_LINES = 40;

export interface StartupDiagnosticsOptions {
  reporter: LifecycleReporter;
  /**
   * Offer the interactive which-log prompt. Defaults to a TTY stdin outside
   * the desktop app — the desktop runs hatch in-process and has no stdin to
   * prompt on.
   */
  interactive?: boolean;
  /** Injection point for tests; defaults to promptLine. */
  promptLineFn?: (prompt: string) => Promise<string>;
  /** Injection point for tests; defaults to tailLines. */
  tailLinesFn?: (filePath: string, maxLines: number) => string[];
  maxTailLines?: number;
}

function isInteractiveFailurePrompting(): boolean {
  return process.stdin.isTTY === true && !process.env.CADET_DESKTOP_APP;
}

/**
 * Best-effort failure report for a failed local startup: point at the logs
 * that were written, surface likely causes found in their tails, and — on an
 * interactive terminal — prompt the operator for which log to view, looping
 * until they skip. Never throws: diagnostics must not mask the original
 * startup error the caller rethrows.
 */
export async function reportStartupFailureDiagnostics(
  resources: LocalAssistantResources | undefined,
  options: StartupDiagnosticsOptions,
): Promise<void> {
  try {
    const reporter = options.reporter;
    const tail = options.tailLinesFn ?? tailLines;
    const maxTailLines = options.maxTailLines ?? VIEW_TAIL_LINES;

    const logs = collectStartupServiceLogs(resources);
    const existing = logs.filter((log) => existsSync(log.path));

    reporter.error("\n   Logs from this attempt:");
    if (existing.length === 0) {
      reporter.error(
        "     (none — the failure happened before any service wrote output)",
      );
    } else {
      for (const log of existing) {
        reporter.error(`     • ${log.service}: ${log.path}`);
      }
    }

    const hints = new Map<string, string>();
    for (const log of existing) {
      for (const detected of detectStartupFailureHints(tail(log.path, 200))) {
        if (!hints.has(detected.hint)) hints.set(detected.hint, detected.line);
      }
    }
    if (hints.size > 0) {
      reporter.error("\n   Likely cause:");
      for (const [hint, line] of hints) {
        reporter.error(`     • ${hint}`);
        reporter.error(`       ${line}`);
      }
    }

    reporter.error(
      "\n   Re-run `cadet hatch -v` to watch startup logs inline.",
    );

    const interactive = options.interactive ?? isInteractiveFailurePrompting();
    if (!interactive || existing.length === 0) return;

    const promptFn = options.promptLineFn ?? promptLine;
    for (;;) {
      reporter.error("\n   Which log would you like to see? (Enter skips)");
      existing.forEach((log, index) => {
        reporter.error(`     ${index + 1}) ${log.service} — ${log.path}`);
      });
      const answer = (
        await promptFn("     Number, or Enter to skip: ")
      ).trim();
      if (answer === "") return;
      const index = Number(answer);
      if (!Number.isInteger(index) || index < 1 || index > existing.length) {
        reporter.error(
          `     Please enter a number between 1 and ${existing.length}, or press Enter to skip.`,
        );
        continue;
      }
      const chosen = existing[index - 1]!;
      const lines = tail(chosen.path, maxTailLines);
      reporter.error(
        `\n   ── last ${lines.length} line${lines.length === 1 ? "" : "s"} of ${chosen.service} ──`,
      );
      for (const line of lines) reporter.error(`   ${line}`);
    }
  } catch {
    // Best effort — the caller rethrows the original startup error.
  }
}
