import { z } from "zod";
import { stampRootProcess } from "../assistant-config.js";
import { readProcessCommandLine, stopProcess } from "../process.js";
import type {
  TunnelProvider,
  ProviderStopOptions,
  ProviderMeta,
  ProviderTunnelResult,
} from "../tunnel.js";

import { spawnSync } from "node:child_process";
import { win32 } from "node:path";

import { GATEWAY_PORT } from "../constants.js";
import { cliCommand } from "../cli-name.js";
import { ensureBinaryInstalled } from "../ensure-binary.js";
import {
  clearIngressUrl,
  loadRawConfig,
  getDefaultWorkspaceDir,
  saveIngressUrl,
  savePairingTunnel,
} from "../ingress-config.js";

// ── Tailscale CLI discovery + invocation ────────────────────────────────────

const MACOS_TAILSCALE_FALLBACK_PATHS = [
  "/opt/homebrew/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];

export function getTailscaleBinaryCandidates(
  hostPlatform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (hostPlatform === "darwin") {
    return ["tailscale", ...MACOS_TAILSCALE_FALLBACK_PATHS];
  }
  if (hostPlatform !== "win32") {
    return ["tailscale"];
  }

  const installRoots = [
    env.ProgramW6432,
    env.ProgramFiles,
    env["ProgramFiles(x86)"],
    env.LOCALAPPDATA,
  ].filter((value): value is string => Boolean(value));
  return [
    "tailscale.exe",
    ...new Set(
      installRoots.map((root) =>
        win32.join(root, "Tailscale", "tailscale.exe"),
      ),
    ),
  ];
}

export function getTailscaleInstallMessage(
  hostPlatform: NodeJS.Platform = process.platform,
): string {
  const platformInstructions =
    hostPlatform === "win32"
      ? "  Windows: winget install Tailscale.Tailscale"
      : hostPlatform === "darwin"
        ? "  macOS:  brew install tailscale, or install the Tailscale app"
        : "  Linux:  https://tailscale.com/download/linux";
  return [
    "Tailscale is not installed or could not be found.",
    "",
    "Install Tailscale:",
    platformInstructions,
    "",
    "Then start it and sign in: `tailscale up`.",
  ].join("\n");
}

export interface TailscaleCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Injectable seam for the tailscale binary. The real implementation shells out
 * via spawnSync; tests provide a fake to exercise the success and error paths
 * without a real tailscale install.
 */
export interface TailscaleDeps {
  /** Locate the tailscale CLI; returns the invocable path, null if absent. */
  findBinary(): Promise<string | null>;
  /** Run `<bin> <args>` synchronously (spawnSync semantics). */
  run(bin: string, args: string[]): TailscaleCommandResult;
}

function probeTailscaleBinary(): string | null {
  for (const candidate of getTailscaleBinaryCandidates()) {
    const res = spawnSync(candidate, ["version"], {
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    if (!res.error && res.status === 0) {
      return candidate;
    }
  }
  return null;
}

/**
 * The real binary finder offers to install tailscale when it is missing
 * (prompt-install via the shared helper; no-op hint on a non-interactive
 * terminal) and re-probes after.
 */
async function realFindBinary(): Promise<string | null> {
  const found = probeTailscaleBinary();
  if (found) return found;
  await ensureBinaryInstalled({
    binary: "tailscale",
    purpose: "the tailscale tunnel",
    packages: {
      brew: ["brew", "install", "tailscale"],
      winget: [
        "winget",
        "install",
        "--silent",
        "--accept-package-agreements",
        "--accept-source-agreements",
        "Tailscale.Tailscale",
      ],
      choco: ["choco", "install", "-y", "tailscale"],
    },
    manualHint: getTailscaleInstallMessage(),
    probe: () => probeTailscaleBinary(),
  });
  return probeTailscaleBinary();
}

function realRun(bin: string, args: string[]): TailscaleCommandResult {
  const res = spawnSync(bin, args, {
    encoding: "utf-8",
    timeout: 15_000,
    windowsHide: true,
  });
  if (res.error) {
    throw res.error;
  }
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

function realTailscaleDeps(): TailscaleDeps {
  return { findBinary: realFindBinary, run: realRun };
}

// ── Status parsing ──────────────────────────────────────────────────────────

interface TailscaleStatus {
  BackendState?: string;
  Self?: { DNSName?: string; Online?: boolean };
}

/** Trim the trailing dot tailscale appends to MagicDNS names. */
export function normalizeDnsName(dnsName: string): string {
  return dnsName.replace(/\.$/, "");
}

/**
 * Validate `tailscale status --json` output and return the MagicDNS hostname
 * (without trailing dot) this machine serves at. Throws a clear error when the
 * daemon is logged out or otherwise not ready to serve.
 */
export function resolveServeHostname(statusJson: string): string {
  let status: TailscaleStatus;
  try {
    status = JSON.parse(statusJson) as TailscaleStatus;
  } catch {
    throw new Error("Could not parse `tailscale status --json` output.");
  }

  const backendState = status.BackendState;
  if (backendState === "NeedsLogin" || backendState === "NoState") {
    throw new Error(
      "Tailscale is not logged in. Run `tailscale up` and try again.",
    );
  }
  if (backendState && backendState !== "Running") {
    throw new Error(
      `Tailscale is not ready (state: ${backendState}). ` +
        "Start Tailscale and run `tailscale up`, then try again.",
    );
  }

  const dnsName = status.Self?.DNSName;
  if (!dnsName) {
    throw new Error(
      "Could not determine this machine's Tailscale DNS name from `tailscale status`. " +
        "Ensure Tailscale is running and signed in (`tailscale up`).",
    );
  }
  return normalizeDnsName(dnsName);
}

function joinOutput(result: TailscaleCommandResult): string {
  return [result.stdout, result.stderr]
    .map((s) => s.trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * Compose an error for a failed `tailscale serve`, surfacing tailscale's own
 * guidance (it prints an enable URL when Serve/HTTPS certs are not enabled for
 * the tailnet) rather than swallowing it.
 */
function serveFailureMessage(result: TailscaleCommandResult): string {
  const detail = joinOutput(result);
  const base =
    "`tailscale serve` failed. This usually means HTTPS certificates or the " +
    "Serve feature are not enabled for your tailnet — follow the link below to " +
    "enable them, then retry.";
  return detail ? `${base}\n\n${detail}` : base;
}

/**
 * The ingress URL may only be cleared once the serve mapping is confirmed
 * stopped. tailscaled maintains the mapping independently of this process, so
 * a failed or errored stop leaves the URL live — clearing the config then
 * would strand webhook configuration while the endpoint still answers.
 */
export function shouldClearIngressUrl(
  result: TailscaleCommandResult | null,
): boolean {
  return result !== null && result.status === 0;
}

// ── Tailscale serve lifecycle ───────────────────────────────────────────────

export interface RunTailscaleTunnelOptions {
  /** Local edge port to serve. Defaults to the global GATEWAY_PORT. */
  port?: number;
  /** Workspace directory for config read/write. Defaults to ~/.cadet/workspace. */
  workspaceDir?: string;
  /** The assistant the records front (`ingress.assistantId`). */
  assistantId?: string;
  /**
   * Publish the tailnet URL to the lockfile entry only, leaving the workspace
   * `ingress` record untouched. Set when the saved public base URL is a live
   * webhook callback base: those callbacks must keep resolving to an address
   * their callers can reach while devices pair over the tailnet.
   */
  preserveIngressUrl?: boolean;
}

/**
 * Record the serve URL as the address to reach this assistant at: the workspace
 * ingress base URL plus the lockfile mirror, or the pairing record plus that
 * mirror when the ingress base URL must be preserved.
 *
 * The pairing card asks the daemon which address is serving this assistant,
 * and the daemon reads the workspace config, so a preserved run that published
 * to the lockfile alone would start a tunnel that card never shows.
 */
function publishServeUrl(
  opts: RunTailscaleTunnelOptions,
  workspaceDir: string,
  publicUrl: string,
): void {
  if (!opts.preserveIngressUrl) {
    saveIngressUrl(workspaceDir, publicUrl, opts.assistantId, "tailscale");
    return;
  }
  savePairingTunnel(
    workspaceDir,
    { provider: "tailscale", publicBaseUrl: publicUrl },
    opts.assistantId,
  );
}

/**
 * Drop what {@link publishServeUrl} recorded, from the same places. Exported
 * for the teardown tests, since the run itself holds until a signal.
 */
export function retractServeUrl(
  opts: RunTailscaleTunnelOptions,
  workspaceDir: string,
): void {
  if (!opts.preserveIngressUrl) {
    clearIngressUrl(workspaceDir);
    return;
  }
  savePairingTunnel(workspaceDir, null);
}

export interface TailscaleServeInfo {
  publicUrl: string;
  port: number;
  binary: string;
  workspaceDir: string;
}

/**
 * Preflight tailscale, front the local edge with `tailscale serve --bg`, and
 * persist the resulting tailnet URL (as the ingress base URL, or as the
 * lockfile pairing address alone under `preserveIngressUrl`).
 *
 * `serve --bg` registers the mapping in tailscaled and returns immediately;
 * there is no long-lived child process to supervise. Throws on any failure
 * (binary missing, logged out, serve not enabled) with actionable guidance.
 */
export async function startTailscaleServe(
  opts: RunTailscaleTunnelOptions = {},
  deps: TailscaleDeps = realTailscaleDeps(),
): Promise<TailscaleServeInfo> {
  const binary = await deps.findBinary();
  if (!binary) {
    throw new Error(getTailscaleInstallMessage());
  }

  const statusResult = deps.run(binary, ["status", "--json"]);
  if (statusResult.status !== 0 || !statusResult.stdout.trim()) {
    const detail = joinOutput(statusResult);
    throw new Error(
      "Could not query Tailscale — is the Tailscale app running? " +
        "Start Tailscale and run `tailscale up`, then try again." +
        (detail ? `\n\n${detail}` : ""),
    );
  }

  const hostname = resolveServeHostname(statusResult.stdout);
  const publicUrl = `https://${hostname}`;

  const workspaceDir = opts.workspaceDir ?? getDefaultWorkspaceDir();
  const port = opts.port ?? GATEWAY_PORT;

  const serveResult = deps.run(binary, ["serve", "--bg", String(port)]);
  if (serveResult.status !== 0) {
    throw new Error(serveFailureMessage(serveResult));
  }

  publishServeUrl(opts, workspaceDir, publicUrl);

  return {
    publicUrl,
    port,
    binary,
    workspaceDir,
  };
}

/**
 * Turn off the HTTPS serve on 443 (the narrow form — leaves any other serve
 * config intact). Returns the command result so callers can report failures.
 */
export function stopTailscaleServe(
  binary: string,
  deps: TailscaleDeps = realTailscaleDeps(),
): TailscaleCommandResult {
  return deps.run(binary, ["serve", "--https=443", "off"]);
}

/**
 * Run the tailscale tunnel workflow: preflight, serve the local edge over the
 * tailnet, and persist the URL. The run is idempotent — re-running
 * re-establishes the serve — and host-safe: nothing is held open and no
 * process-level signal handling is registered, so the wake and upgrade
 * restores can invoke it in-process.
 *
 * The tailnet URL carries a real LetsEncrypt certificate but is reachable only
 * from devices signed in to the same tailnet: no public exposure.
 */
export async function runTailscaleTunnel(
  opts: RunTailscaleTunnelOptions = {},
): Promise<ProviderTunnelResult> {
  const deps = realTailscaleDeps();

  console.log("Setting up tailscale serve...");
  const { publicUrl, port, workspaceDir } = await startTailscaleServe(
    opts,
    deps,
  );

  console.log("");
  console.log(`Tunnel established: ${publicUrl}`);
  console.log(`Serving:            localhost:${port}`);
  console.log("");
  console.log(
    opts.preserveIngressUrl
      ? "Recorded as this assistant's pairing address. The saved ingress base URL, which is also the webhook callback base, is left as it was."
      : "Ingress URL saved to config.",
  );
  console.log(
    "This URL is reachable only from devices signed in to your tailnet.",
  );
  console.log(
    `For public webhook ingress, run \`${cliCommand()} tunnel start --help\` to see the public providers.`,
  );
  console.log("");
  console.log(
    `The serve persists in tailscaled after this command exits. Stop it with \`${cliCommand()} tunnel stop\`.`,
  );

  stampRootProcess("tunnel", {
    pid: process.pid,
    provider: "tailscale",
    startedAt: new Date().toISOString(),
  });

  // The serve itself lives in tailscaled and persists after this process
  // exits; no signal handling is registered and nothing is held open — a
  // run must be safe to invoke from a host process (the wake/upgrade
  // restore). Stopping is the stop path: `cadet tunnel stop`.
  const waitForExit = new Promise<void>(() => {});
  return { publicUrl, waitForExit };
}

/** Per-provider copy `cadet tunnel`'s help renders for tailscale. */
export const TAILSCALE_TUNNEL_META: ProviderMeta = {
  reach: "Tailnet-only tunnel, reachable from your own devices",
  install: "install: https://tailscale.com/download, then run `tailscale up`",
  notes: [
    "When webhook integrations are configured it records its URL for device",
    "pairing only, leaving the saved webhook callback base as it is.",
  ],
  supportsReservedDomain: false,
};

const stoppedTailscaleStateSchema = z.object({
  ingress: z
    .object({
      publicBaseUrl: z.string().optional(),
      pairingTunnel: z.object({ provider: z.string() }).optional(),
    })
    .optional(),
});

export async function stopTailscaleTunnel(
  opts: ProviderStopOptions,
  deps: TailscaleDeps = {
    findBinary: async () => probeTailscaleBinary(),
    run: realRun,
  },
): Promise<boolean> {
  const binary = await deps.findBinary();
  if (!binary) throw new Error(getTailscaleInstallMessage());
  const result = stopTailscaleServe(binary, deps);
  if (result.status !== 0)
    throw new Error(`Could not stop tailscale serve: ${joinOutput(result)}`);
  // The serve belongs to tailscaled; only the Cadet supervisor may be signaled.
  let supervisor = false;
  try {
    const command = readProcessCommandLine(opts.record.pid);
    supervisor =
      /cadet/i.test(command) && /(?:^|\s)tunnel(?:\s|$)/.test(command);
  } catch {
    /* The supervisor may already have exited. */
  }
  if (supervisor && opts.record.pid !== process.pid)
    await stopProcess(opts.record.pid, "tunnel supervisor");
  if (opts.workspaceDir) {
    const state = stoppedTailscaleStateSchema.parse(
      loadRawConfig(opts.workspaceDir),
    ).ingress;
    const assistantId = opts.assistantId;
    retractServeUrl(
      {
        assistantId,
        preserveIngressUrl: state?.pairingTunnel?.provider === "tailscale",
      },
      opts.workspaceDir,
    );
  }
  return true;
}

export const TAILSCALE_PROVIDER: TunnelProvider = {
  run: runTailscaleTunnel,
  stop: stopTailscaleTunnel,
};
