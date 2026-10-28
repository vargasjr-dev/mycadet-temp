import {
  clearRootProcess,
  readRootProcesses,
  stampRootProcess,
} from "../assistant-config.js";
import { readProcessCommandLine } from "../process.js";
import { stopOwnedTunnelAgent } from "./process-lifecycle.js";
import type {
  TunnelProvider,
  ProviderMeta,
  ProviderTunnelResult,
} from "../tunnel.js";

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { cliCommand } from "../cli-name.js";
import { ensureBinaryInstalled } from "../ensure-binary.js";

import { GATEWAY_PORT } from "../constants.js";
import { resolveDataDir } from "@mycadet/local-mode";

// ── Cloudflare Tunnel ─────────────────────────────────────────────────────────

const CLOUDFLARED_TIMEOUT_MS = 30_000;

// Quick-tunnel hostnames follow the pattern <word>-<word>-<word>.trycloudflare.com
const QUICK_TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

/** Whether the pid runs a cloudflared agent (the stop path's identity check). */
function isCloudflaredProcess(pid: number): boolean {
  try {
    return /(?:^|[\\/\s])cloudflared(?:\.exe)?(?:\s|$)/i.test(
      readProcessCommandLine(pid),
    );
  } catch {
    return false;
  }
}

/**
 * Poll the agent's log file for the quick-tunnel URL (the detached agent's
 * output lands there instead of in pipes).
 */
function waitForCloudflareTunnelUrlInLog(
  logPath: string,
  timeoutMs: number = CLOUDFLARED_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      try {
        const contents = readFileSync(logPath, "utf-8");
        const match = QUICK_TUNNEL_URL_RE.exec(contents);
        if (match) {
          clearInterval(timer);
          resolve(match[0]);
        }
      } catch {
        // The log file may not exist yet.
      }
    }, 250);
    setTimeout(() => {
      clearInterval(timer);
      reject(
        new Error(
          `cloudflared tunnel URL did not appear within ${timeoutMs / 1000}s. ` +
            `Ensure cloudflared is working: try running 'cloudflared tunnel --url http://localhost:7840' manually.`,
        ),
      );
    }, timeoutMs);
  });
}

/**
 * Check whether cloudflared is installed and on PATH.
 * Returns the version string if found, null otherwise.
 */
export function getCloudflareTunnelVersion(): string | null {
  try {
    const output = execFileSync("cloudflared", ["version"], {
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    return output.trim();
  } catch {
    return null;
  }
}

/**
 * Spawn a cloudflared quick-tunnel process forwarding HTTP traffic to
 * `targetPort`.  The child process writes its public URL to stderr during
 * startup — use {@link waitForCloudflareTunnelUrl} to extract it.
 */
export function startCloudflareTunnelProcess(targetPort: number): ChildProcess {
  return spawn(
    "cloudflared",
    ["tunnel", "--url", `http://localhost:${targetPort}`, "--no-autoupdate"],
    // Keep stdio as pipes so we can parse the URL from output.
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
}

/**
 * Listen to a running cloudflared process's stdout/stderr and resolve with
 * the public quick-tunnel URL once cloudflared prints it.
 *
 * cloudflared emits a line containing the trycloudflare.com URL during
 * startup — typically within 5–15 seconds on a normal internet connection.
 *
 * Rejects when:
 * - The URL does not appear within `timeoutMs`.
 * - The child process exits before the URL is found.
 */
export function waitForCloudflareTunnelUrl(
  child: ChildProcess,
  timeoutMs: number = CLOUDFLARED_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `cloudflared tunnel URL did not appear within ${timeoutMs / 1000}s. ` +
            `Ensure cloudflared is working: try running 'cloudflared tunnel --url http://localhost:7840' manually.`,
        ),
      );
    }, timeoutMs);

    let resolved = false;

    function scanLine(line: string): void {
      if (resolved) return;
      const match = QUICK_TUNNEL_URL_RE.exec(line);
      if (match) {
        resolved = true;
        clearTimeout(timer);
        resolve(match[0]);
      }
    }

    // Buffer incomplete lines across chunks
    let stdoutBuf = "";
    let stderrBuf = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() ?? "";
      for (const line of lines) scanLine(line);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString();
      const lines = stderrBuf.split("\n");
      stderrBuf = lines.pop() ?? "";
      for (const line of lines) scanLine(line);
    });

    child.on("exit", (code) => {
      if (child.pid) clearRootProcess("tunnel", child.pid);
      if (resolved) return;
      clearTimeout(timer);
      reject(
        new Error(
          `cloudflared exited with code ${code ?? "unknown"} before the tunnel URL appeared.`,
        ),
      );
    });
  });
}

/**
 * Run the cloudflared quick-tunnel workflow:
 * 1. Verify cloudflared is installed.
 * 2. Start a quick tunnel pointing at the local edge port.
 * 3. Parse the public URL from cloudflared output.
 * 4. Persist the URL to the workspace config as the ingress base URL.
 * 5. Block until the process exits or the user presses Ctrl+C.
 * 6. Clear the ingress URL from config on exit.
 *
 * No Cloudflare account is required — quick tunnels are free and ephemeral.
 */
export interface RunCloudflareTunnelOptions {
  /** Local edge port to forward. Defaults to the global GATEWAY_PORT. */
  port?: number;
  /** Lockfile entry to mirror the ingress URL onto (`ingressUrl`). */
  assistantId?: string;
}

export async function runCloudflareTunnel(
  opts: RunCloudflareTunnelOptions = {},
): Promise<ProviderTunnelResult> {
  const version = await ensureBinaryInstalled({
    binary: "cloudflared",
    purpose: "the cloudflare tunnel",
    packages: {
      brew: ["brew", "install", "cloudflare/cloudflare/cloudflared"],
      winget: [
        "winget",
        "install",
        "--silent",
        "--accept-package-agreements",
        "--accept-source-agreements",
        "Cloudflare.cloudflared",
      ],
      choco: ["choco", "install", "-y", "cloudflared"],
    },
    manualHint:
      "See https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ for how to install",
    probe: getCloudflareTunnelVersion,
  });
  if (!version) {
    // A run can be invoked from a host process (the wake/upgrade restore
    // ensures the recorded tunnel by running this), so failures throw for
    // the caller to surface — only the command turns them into an exit.
    throw new Error("cloudflared is not installed.");
  }

  console.log(`Using ${version}`);

  const port = opts.port ?? GATEWAY_PORT;

  // Idempotency: the recorded agent may still be alive (a CLI restart, or
  // the wake/upgrade restore re-running this in-process). Adopt it instead
  // of stacking a second quick tunnel — a fresh agent mints a NEW
  // trycloudflare URL for nothing.
  const recorded = readRootProcesses().tunnel;
  if (
    recorded?.provider === "cloudflare" &&
    recorded.pid &&
    isCloudflaredProcess(recorded.pid)
  ) {
    const existingUrl = recorded.publicUrl;
    if (existingUrl) {
      console.log(`Found existing cloudflare tunnel: ${existingUrl}`);
      // Not our child process; nothing to await, and no signal handling is
      // registered — a run must be safe to invoke from a host process.
      return { publicUrl: existingUrl, waitForExit: Promise.resolve() };
    }
  }

  console.log(`Starting cloudflared quick tunnel to localhost:${port}...`);
  console.log("No Cloudflare account required — quick tunnels are free.");
  console.log("");

  // The agent is spawned detached with its output in a log file instead of
  // pipes — same rationale as the ngrok agent: a run is invoked by the
  // wake/upgrade restore in host processes the CLI must be free to exit,
  // and pipe handles left open hang them. The quick-tunnel URL is read
  // from the log instead of pipes.
  const logDir = join(resolveDataDir(), "logs");
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, "cloudflared.log");
  const logFd = openSync(logPath, "a");
  const child = spawn(
    "cloudflared",
    ["tunnel", "--url", `http://localhost:${port}`, "--no-autoupdate"],
    { stdio: ["ignore", logFd, logFd], windowsHide: true },
  );
  closeSync(logFd);
  child.unref();

  // Failures reject these instead of exiting, so the command can turn them
  // into an exit and a host-process restore can move on.
  const spawnFailure = new Promise<never>((_, reject) => {
    child.on("error", (err: Error) => {
      console.error(`cloudflared process error: ${err.message}`);
      reject(new Error(`cloudflared process error: ${err.message}`));
    });
  });
  const exitFailure = new Promise<never>((_, reject) => {
    child.on("exit", (code) => {
      clearRootProcess("tunnel");
      reject(new Error(`cloudflared exited with code ${code}.`));
    });
  });

  let publicUrl: string;
  try {
    publicUrl = await Promise.race([
      waitForCloudflareTunnelUrlInLog(logPath),
      spawnFailure,
      exitFailure,
    ]);
  } catch (err) {
    if (!child.killed) child.kill("SIGTERM");
    clearRootProcess("tunnel");
    throw err;
  }

  console.log("");
  console.log(`Tunnel established: ${publicUrl}`);
  console.log(`Forwarding to:     localhost:${port}`);
  console.log("");

  if (child.pid)
    stampRootProcess("tunnel", {
      pid: child.pid,
      provider: "cloudflare",
      startedAt: new Date().toISOString(),
      publicUrl,
    });
  console.log("Tunnel recorded in the lockfile.");
  console.log("");
  console.log(
    `The agent runs detached (log: ${logPath}). Stop it with \`${cliCommand()} tunnel stop\`.`,
  );

  // Settles when the detached agent exits. No process-level signal handling
  // is registered: the detached agent outlives the CLI either way.
  const waitForExit = new Promise<void>((resolve) => {
    child.on("exit", () => resolve());
  });
  return { publicUrl, waitForExit };
}

/** Per-provider copy `cadet tunnel`'s help renders for cloudflare. */
export const CLOUDFLARE_TUNNEL_META: ProviderMeta = {
  reach: "Public tunnel that webhook integrations can reach",
  install: "install: brew install cloudflare/cloudflare/cloudflared",
  notes: ["No Cloudflare account required for quick tunnels."],
  supportsReservedDomain: false,
};

export const CLOUDFLARE_PROVIDER: TunnelProvider = {
  run: runCloudflareTunnel,
  stop: (opts) =>
    stopOwnedTunnelAgent(
      opts,
      (pid) => {
        try {
          return /(?:^|[\\/\s])cloudflared(?:\.exe)?(?:\s|$)/i.test(
            readProcessCommandLine(pid),
          );
        } catch {
          return false;
        }
      },
      "cloudflared",
    ),
};
