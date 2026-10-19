#!/usr/bin/env bun
/**
 * Wait for the dev servers (Vite) to answer, then exit 0 — a drop-in for
 * `wait-on http://...`, with a diagnostic tail for hung Vite startups.
 *
 * Accepts any number of URLs; every one must answer before electron launches
 * (web Vite for auxiliary windows, app-shell Vite for the main window).
 *
 * Vite startup can wedge indefinitely before it binds the port, and the
 * teardown that follows this script's failure exit is what un-wedges it:
 * `concurrently --kill-others` SIGTERMs the web half, Vite completes startup
 * while dying, and its log reads "ready in <≈ the timeout>". The hang
 * therefore leaves no trace of where it was stuck unless that trace is
 * captured from the outside, before teardown. On timeout this script writes
 * that capture to /tmp: a wall-clock stack sample (`sample`) of each Vite
 * process on the dev port, the port's listener state, and a reachability
 * probe taken after polling has stopped.
 *
 * Best-effort by design: capture failures are logged and the script still
 * exits 1, so the dev orchestration behaves exactly as it did with `wait-on`.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const DEFAULT_URL = "http://localhost:5173";
const DEFAULT_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 250;
const PROBE_TIMEOUT_MS = 2_000;
const SAMPLE_SECONDS = 2;
const MAX_SAMPLED_PROCESSES = 4;

const args = process.argv.slice(2);
let timeoutMs = DEFAULT_TIMEOUT_MS;
// Every non-flag argument is a server to wait for — the dev flow starts both
// the web Vite (auxiliary windows) and the app-shell Vite (main window), and
// electron must not launch until both answer.
let urls: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--timeout") {
    const value = Number(args[++i]);
    if (!Number.isFinite(value) || value <= 0) {
      console.error(`[dev] invalid --timeout value: ${args[i]}`);
      process.exit(2);
    }
    timeoutMs = value;
  } else {
    urls.push(args[i]!);
  }
}
if (urls.length === 0) {
  urls = [DEFAULT_URL];
}
const ports = urls.map((u) => Number(new URL(u).port || "80"));

async function isUp(target: string, probeTimeoutMs: number): Promise<boolean> {
  try {
    const res = await fetch(target, {
      signal: AbortSignal.timeout(probeTimeoutMs),
    });
    // Any non-5xx response counts — even a 404 means the server is up and
    // serving HTTP (Vite answers the bare root with a base-URL hint page).
    return res.status < 500;
  } catch {
    return false;
  }
}

/** Run a command and capture stdout, with a hard timeout so a wedged
 * diagnostic tool can't hang the diagnostics. */
function run(cmd: string, argv: string[], commandTimeoutMs = 20_000): string {
  return execFileSync(cmd, argv, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: commandTimeoutMs,
  });
}

/** Every process whose command names `vite` and carries `--port <port>` —
 * catches both the `bun --bun vite` wrapper and the node Vite it spawns,
 * while excluding `electron-vite` (different port) and shell wrappers. */
function viteProcessesOnPort(targetPort: number): Array<{ pid: number; command: string }> {
  let psOut: string;
  try {
    psOut = run("ps", ["ax", "-o", "pid=,command="]);
  } catch {
    return [];
  }
  const procs: Array<{ pid: number; command: string }> = [];
  for (const line of psOut.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!match) {
      continue;
    }
    const pid = Number(match[1]);
    const command = match[2]!;
    if (pid === process.pid) {
      continue;
    }
    if (/\bvite\b/.test(command) && command.includes(`--port ${targetPort}`)) {
      procs.push({ pid, command });
    }
  }
  return procs;
}

/** Wall-clock stack sample of a process via macOS `sample` — shows the exact
 * frames a stuck process is blocked in. */
function sampleProcess(pid: number): string {
  const sampleFile = `/tmp/cadet-dev-vite-hang-sample-${pid}.txt`;
  try {
    run("sample", [String(pid), String(SAMPLE_SECONDS), "-mayDie", "-file", sampleFile]);
    const text = fs.readFileSync(sampleFile, "utf8");
    fs.rmSync(sampleFile, { force: true });
    return text;
  } catch (err) {
    return `sample failed for PID ${pid}: ${(err as Error).message}\n`;
  }
}

async function captureHangDiagnostics(): Promise<string> {
  const stamp = new Date().toISOString().replace(/:/g, "-");
  const reportPath = `/tmp/cadet-dev-vite-hang-${stamp}.txt`;
  const sections: string[] = [
    `Vite dev-server hang capture — ${new Date().toISOString()}`,
    `Waited ${timeoutMs}ms for ${urls.join(", ")} with no response.`,
  ];

  for (const [i, u] of urls.entries()) {
    const p = ports[i]!;
    const procs = viteProcessesOnPort(p);
    if (procs.length > 0) {
      sections.push(
        `Vite processes on port ${p}:\n${procs.map((pr) => `  ${pr.pid}  ${pr.command}`).join("\n")}`,
      );
    } else {
      sections.push(`No Vite processes matching --port ${p} found in ps output.`);
    }

    try {
      sections.push(`lsof -nP -iTCP:${p}:\n${run("lsof", ["-nP", `-iTCP:${p}`])}`);
    } catch {
      sections.push(`lsof -nP -iTCP:${p}: no sockets (nothing bound or listening).`);
    }

    for (const proc of procs.slice(0, MAX_SAMPLED_PROCESSES)) {
      sections.push(`===== sample of PID ${proc.pid} (${proc.command}) =====\n${sampleProcess(proc.pid)}`);
    }

    // Polling stopped when the wait deadline passed; a server that answers
    // here but never answered during the wait implicates the polling itself.
    const reachable = await isUp(u, 1_000);
    sections.push(
      `Reachability probe for ${u} after polling stopped and samples were taken: ${reachable ? "SERVER ANSWERED" : "still unreachable"}.`,
    );
  }

  fs.writeFileSync(reportPath, `${sections.join("\n\n")}\n`);
  return reportPath;
}

const deadline = Date.now() + timeoutMs;
let up = false;
while (Date.now() < deadline) {
  const states = await Promise.all(urls.map((u) => isUp(u, PROBE_TIMEOUT_MS)));
  if (states.every((s) => s)) {
    up = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
}

if (up) {
  process.exit(0);
}

console.error(
  `[dev] timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${urls.join(", ")} — capturing hang diagnostics before exiting.`,
);
try {
  const reportPath = await captureHangDiagnostics();
  console.error(`[dev] wrote hang diagnostics (stack samples + port state) to:`);
  console.error(`[dev]   ${reportPath}`);
  console.error(`[dev] attach that file when investigating the Vite startup hang.`);
} catch (err) {
  console.error(`[dev] hang diagnostics capture failed: ${(err as Error).message}`);
}
process.exit(1);
