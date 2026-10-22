import { clearRootProcess, stampRootProcess } from "../assistant-config.js";
import { readProcessCommandLine } from "../process.js";
import { stopOwnedTunnelAgent } from "./process-lifecycle.js";
import type {
  TunnelProvider,
  ProviderMeta,
  ProviderTunnelResult,
} from "../tunnel.js";

import { execFileSync, spawn, type ChildProcess } from "node:child_process";

import { ensureBinaryInstalled } from "../ensure-binary.js";

import { GATEWAY_PORT } from "../constants.js";
import {
  clearIngressUrl,
  getDefaultWorkspaceDir,
  saveIngressUrl,
} from "../ingress-config.js";

// ── Cloudflare Tunnel ─────────────────────────────────────────────────────────

const CLOUDFLARED_TIMEOUT_MS = 30_000;

// Quick-tunnel hostnames follow the pattern <word>-<word>-<word>.trycloudflare.com
const QUICK_TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

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
  /** Workspace directory for config read/write. Defaults to ~/.cadet/workspace. */
  workspaceDir?: string;
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
    process.exit(1);
  }

  console.log(`Using ${version}`);

  const workspaceDir = opts.workspaceDir ?? getDefaultWorkspaceDir();
  const port = opts.port ?? GATEWAY_PORT;

  console.log(`Starting cloudflared quick tunnel to localhost:${port}...`);
  console.log("No Cloudflare account required — quick tunnels are free.");
  console.log("");

  let publicUrl: string | undefined;
  const child = startCloudflareTunnelProcess(port);

  const cleanup = (): void => {
    if (!child.killed) child.kill("SIGTERM");
    if (child.pid) clearRootProcess("tunnel", child.pid);
    if (publicUrl) {
      console.log("\nClearing ingress URL from config...");
      clearIngressUrl(workspaceDir);
    }
  };

  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });

  child.on("error", (err: Error) => {
    console.error(`cloudflared process error: ${err.message}`);
    process.exit(1);
  });

  child.on("exit", (code) => {
    if (child.pid) clearRootProcess("tunnel", child.pid);
    // Always clear the saved ingress URL when the tunnel process ends so
    // webhook integrations don't keep hitting a dead endpoint.
    if (publicUrl !== undefined) {
      clearIngressUrl(workspaceDir);
    }
    if (code !== null && code !== 0) {
      console.error(`\ncloudflared exited with code ${code}.`);
      process.exit(1);
    }
  });

  // Forward cloudflared output to the console so the user can see startup
  // progress and any authentication errors.
  child.stdout?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) console.log(`[cloudflared] ${line}`);
  });
  child.stderr?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) console.log(`[cloudflared] ${line}`);
  });

  try {
    publicUrl = await waitForCloudflareTunnelUrl(child);
  } catch (err) {
    cleanup();
    throw err;
  }

  console.log("");
  console.log(`Tunnel established: ${publicUrl}`);
  console.log(`Forwarding to:     localhost:${port}`);
  console.log("");

  saveIngressUrl(workspaceDir, publicUrl, opts.assistantId, "cloudflare");
  if (child.pid)
    stampRootProcess("tunnel", {
      pid: child.pid,
      provider: "cloudflare",
      startedAt: new Date().toISOString(),
    });
  console.log("Ingress URL saved to config.");
  console.log("");
  console.log("Press Ctrl+C to stop the tunnel and clear the ingress URL.");

  // Keep running until cloudflared exits (e.g., network error or user Ctrl+C)
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
