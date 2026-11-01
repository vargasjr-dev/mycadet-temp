import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { resolveLogDir } from "@mycadet/local-mode";
import { openLogFile, resetLogFile } from "./xdg-log.js";

export interface RelaunchDetachedOptions {
  /** argv for the re-invoked CLI command, e.g. ["tunnel", "--provider", "cloudflare"]. */
  args: string[];
  /** Log file basename under the XDG log dir; truncated before spawn. */
  logFile: string;
  /**
   * Polled (with the resolved log path) until it resolves truthy, the child
   * exits, or timeoutMs elapses.
   */
  isReady: (logPath: string) => Promise<boolean> | boolean;
  timeoutMs: number;
  pollIntervalMs?: number;
  /**
   * Extra environment for the child, merged over the parent's env. Used for
   * detached-child markers: the child re-enters the same command and must
   * know it is the detached worker, not the terminal-facing parent.
   */
  env?: Record<string, string>;
}

export interface DetachedRelaunchResult {
  child: ChildProcess;
  logPath: string;
  /** True once `isReady` returned truthy before the child exited or the timeout elapsed. */
  ready: boolean;
  /** The child's exit code, or `null` for a spawn error. Undefined while still running. */
  exitCode: number | null | undefined;
}

/**
 * The argv to re-invoke the CLI with. A compiled binary runs as
 * `<binary> <args>` — process.execPath IS the CLI and `args` already reads
 * as command arguments. A source checkout runs as `bun <entry.ts> <args>`:
 * process.execPath is the bun binary, so re-invoking it with bare args would
 * ask bun to execute a script named e.g. "tunnel" (Script not found). The
 * entry script must ride along as the next argv element. Only a real script
 * file triggers the arm — a compiled binary's argv[1] is the first user arg.
 */
function childArgv(args: string[]): string[] {
  const entry = process.argv[1];
  if (
    entry &&
    entry !== process.execPath &&
    /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry) &&
    existsSync(entry) &&
    statSync(entry).isFile()
  ) {
    return [process.execPath, entry, ...args];
  }
  return [process.execPath, ...args];
}

/**
 * Re-invoke the current CLI binary with `args` as a detached background
 * process, redirecting stdout/stderr to `logFile` in the XDG log dir, then
 * poll `isReady` until it succeeds, the child exits, or `timeoutMs` elapses.
 *
 * Shared by every command that offers a detached/background mode (e.g.
 * `cadet tunnel start`) so the spawn/log/poll mechanics live in one place;
 * each caller supplies its own readiness check and decides how to react to a
 * timeout or early exit.
 */
export async function relaunchDetached(
  opts: RelaunchDetachedOptions,
): Promise<DetachedRelaunchResult> {
  resetLogFile(opts.logFile);
  const fd = openLogFile(opts.logFile);
  const [file, ...spawnArgs] = childArgv(opts.args);
  const child = spawn(file, spawnArgs, {
    detached: true,
    stdio: ["ignore", fd, fd],
    windowsHide: true,
    env: { ...process.env, ...opts.env },
  });
  if (typeof fd === "number") {
    closeSync(fd);
  }
  child.unref();

  const logPath = join(resolveLogDir(), opts.logFile);

  let exitCode: number | null | undefined;
  child.on("error", () => {
    exitCode = null;
  });
  child.on("exit", (code) => {
    exitCode = code;
  });

  const deadline = Date.now() + opts.timeoutMs;
  const pollIntervalMs = opts.pollIntervalMs ?? 250;
  let ready = false;
  while (Date.now() < deadline && exitCode === undefined) {
    if (await opts.isReady(logPath)) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  return { child, logPath, ready, exitCode };
}
