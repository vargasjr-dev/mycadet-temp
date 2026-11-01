import { readFileSync } from "node:fs";

import {
  TUNNEL_PROVIDERS,
  type TunnelProviderName,
} from "@mycadet/service-contracts/ingress";

import { readRootProcesses } from "../lib/assistant-config";
import { relaunchDetached } from "../lib/detached-process.js";
import { ensureAppServer, type AppServer } from "../lib/servers/nginx.js";
import { STALE_CLI_UPDATE_HINT } from "../lib/stale-cli-hint.js";
import {
  DEFAULT_TUNNEL_PROVIDER,
  PROVIDER_META,
  adoptedTunnelStopNotice,
  clearReservedDomain,
  ensureNginxForEdge,
  offerStopNgrokHolder,
  providerSupportsReservedDomain,
  runProviderTunnel,
  stopTunnelProcess,
  summarizeStartupFailure,
} from "../lib/tunnel.js";
import { ADOPTED_TUNNEL_RE } from "../lib/tunnels/ngrok.js";
import { cadetTunnelComingSoonError } from "../lib/tunnels/cadet.js";
import { cliCommandName } from "@mycadet/local-mode";
import { printRootProcessDetail } from "./ps.js";

// The accepted `--provider` values ARE the shared registry, so validation
// here cannot drift from what the workspace config accepts.

interface TunnelArgs {
  provider: TunnelProviderName;
  domain: string | null;
  clearDomain: boolean;
  foreground: boolean;
}

function parseArgs(): TunnelArgs {
  // argv[3] is the `start` subcommand — the entrypoint dispatches on it.
  const args = process.argv.slice(4);
  let provider: TunnelProviderName | null = null;
  let domain: string | null = null;
  let clearDomain = false;
  let foreground = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      console.log(
        `Usage: ${cliCommandName()} tunnel start --provider <provider> [options]\n       ${cliCommandName()} tunnel stop`,
      );
      console.log("");
      console.log("Front a locally running assistant with an HTTPS tunnel.");
      console.log(
        "The tunnel URL is saved to the workspace config as the ingress base URL,",
      );
      console.log(
        "and shared with every locally reachable assistant's gateway when the",
      );
      console.log("tunnel establishes.");
      console.log("");
      console.log(
        "How far that URL reaches depends on the provider; omit --provider for",
      );
      console.log(
        "the default. A tailscale tunnel is reachable only from your",
      );
      console.log(
        "own tailnet; webhook integrations need a public tunnel. See Providers",
      );
      console.log("below.");
      console.log("");
      console.log(
        "The tunnel always fronts the local nginx edge, which is started automatically.",
      );
      console.log(
        "nginx must be installed; if it is missing, cadet offers to install it.",
      );
      console.log("");
      console.log("Options:");
      console.log(
        `  --provider <provider>         Tunnel provider: ${TUNNEL_PROVIDERS.join(", ")} — default ${DEFAULT_TUNNEL_PROVIDER}`,
      );
      console.log(
        "  --domain <domain>             Reserved domain to bind, for providers that support",
      );
      console.log(
        "                                one. Saved to the workspace config so `${cliCommandName()} wake` restores",
      );
      console.log("                                reuse it.");
      console.log(
        "  --clear-domain                Clear the saved reserved domain (same providers) and",
      );
      console.log(
        "                                tunnel without one. Cannot be combined with --domain.",
      );
      console.log(
        `  --foreground                  Stream the tunnel's logs to this terminal. By default the tunnel`,
      );
      console.log(
        "                                runs in the background: the command returns after printing the public",
      );
      console.log(
        `                                URL, and logs stream to tunnel.log in the CLI log directory. A background`,
      );
      console.log(
        "                                tunnel stops with `${cliCommandName()} tunnel stop`, except when it adopted an already-running",
      );
      console.log(
        "                                tunnel (started outside this command): killing the supervisor then",
      );
      console.log(
        "                                leaves that tunnel running.",
      );
      console.log("");
      console.log("Providers:");
      for (const name of TUNNEL_PROVIDERS) {
        const meta = PROVIDER_META[name];
        console.log(`  ${name.padEnd(12)}${meta.reach}`);
        console.log(`  ${" ".repeat(12)}${meta.install}`);
        for (const note of meta.notes ?? []) {
          console.log(`  ${" ".repeat(12)}${note}`);
        }
      }
      console.log("");
      console.log("Examples:");
      console.log(
        `  $ ${cliCommandName()} tunnel start --provider ${DEFAULT_TUNNEL_PROVIDER}`,
      );
      const domainExample =
        PROVIDER_META[DEFAULT_TUNNEL_PROVIDER].domainExample;
      if (domainExample) {
        console.log(
          `  $ ${cliCommandName()} tunnel start --provider ${DEFAULT_TUNNEL_PROVIDER} --domain ${domainExample}`,
        );
        console.log(
          `  $ ${cliCommandName()} tunnel start --provider ${DEFAULT_TUNNEL_PROVIDER} --clear-domain`,
        );
      }
      console.log(`  $ ${cliCommandName()} tunnel start --provider cloudflare`);
      console.log(`  $ ${cliCommandName()} tunnel stop`);
      process.exit(0);
    } else if (arg === "--provider") {
      const next = args[i + 1];
      if (!next || next.startsWith("-")) {
        console.error(
          `Error: --provider requires one of: ${TUNNEL_PROVIDERS.join(", ")}`,
        );
        process.exit(1);
      }
      if (!TUNNEL_PROVIDERS.includes(next as TunnelProviderName)) {
        console.error(
          `Error: unknown tunnel provider '${next}'. Valid providers: ${TUNNEL_PROVIDERS.join(", ")}.`,
        );
        console.error(
          `If this provider is documented, ${STALE_CLI_UPDATE_HINT}`,
        );
        process.exit(1);
      }
      provider = next as TunnelProviderName;
      i++;
    } else if (arg === "--domain") {
      const next = args[i + 1];
      if (!next || next.startsWith("-")) {
        const domainExample =
          PROVIDER_META[DEFAULT_TUNNEL_PROVIDER].domainExample;
        console.error(
          `Error: --domain requires a value${domainExample ? `, e.g. --domain ${domainExample}` : ""}`,
        );
        process.exit(1);
      }
      domain = next;
      i++;
    } else if (arg === "--clear-domain") {
      clearDomain = true;
    } else if (arg === "--foreground") {
      foreground = true;
    } else if (arg.startsWith("-")) {
      console.error(`Error: Unknown option '${arg}'.`);
      process.exit(1);
    }
  }

  if (provider === null) {
    provider = DEFAULT_TUNNEL_PROVIDER;
    console.log(`Using the default provider: ${provider}.`);
  }

  if (domain && !providerSupportsReservedDomain(provider)) {
    console.error(
      `Error: --domain is not supported with --provider ${provider} (reserved domains have no equivalent there).`,
    );
    process.exit(1);
  }

  if (clearDomain && !providerSupportsReservedDomain(provider)) {
    console.error(
      `Error: --clear-domain is not supported with --provider ${provider} (reserved domains have no equivalent there).`,
    );
    process.exit(1);
  }

  if (clearDomain && domain) {
    console.error(
      "Error: --clear-domain cannot be combined with --domain. Pass --domain alone to replace the saved domain.",
    );
    process.exit(1);
  }

  // No positionals exist anymore — but the scan must skip the values of the
  // two value-taking flags, or those values read as stray positionals.
  const valueFlags = new Set(["--provider", "--domain"]);
  const positional = args.find(
    (arg, i) => !arg.startsWith("-") && !valueFlags.has(args[i - 1] ?? ""),
  );
  if (positional !== undefined) {
    console.error(
      `Error: Unknown argument '${positional}'. ${cliCommandName()} tunnel takes no assistant name — it fronts the active assistant; use \`${cliCommandName()} tunnel start\` or \`${cliCommandName()} tunnel stop\`.`,
    );
    process.exit(1);
  }

  return { provider, domain, clearDomain, foreground };
}

/** A tunnelable assistant plus the gateway port and workspace the edge fronts. */
// Generous cap so a slow provider handshake (e.g. cloudflared's own ~30s
// quick-tunnel timeout) still counts as a successful, if slow, start.
const TUNNEL_BACKGROUND_START_TIMEOUT_MS = 35_000;
// Matches the "just established" line every provider prints, or the adoption
// line printed when a run adopts an already-running agent's tunnel (captured
// separately since that case does not own the tunnel it adopted).
const TUNNEL_ESTABLISHED_RE = /Tunnel established: (\S+)/;

/**
 * Re-invoke `cadet tunnel --foreground` as a detached background process via
 * `relaunchDetached`, waiting for the child to either print its
 * "Tunnel established" or adopted-tunnel line (readiness) or exit early
 * (failure), so a misconfigured provider still fails loudly in the terminal
 * that ran `cadet tunnel`.
 *
 * The log file is the fixed `tunnel.log` so there is one stable path to tail;
 * concurrent tunnel runs share (and truncate) it.
 */
async function spawnDetachedTunnel(): Promise<void> {
  const childArgs: string[] = ["tunnel"];
  for (const arg of process.argv.slice(3)) {
    if (arg === "--foreground") {
      continue;
    }
    childArgs.push(arg);
  }
  childArgs.push("--foreground");

  let publicUrl: string | undefined;
  let adopted = false;

  // One confirm-first round for a held ngrok domain: the detached child has
  // no TTY, so the prompt inside its own spawn loop can never fire — the
  // heal can only happen HERE, in the terminal that ran the command.
  for (let holderStops = 0; ; holderStops++) {
    const { child, logPath, ready, exitCode } = await relaunchDetached({
      args: childArgs,
      logFile: "tunnel.log",
      timeoutMs: TUNNEL_BACKGROUND_START_TIMEOUT_MS,
      isReady: (logPath) => {
        let logText = "";
        try {
          logText = readFileSync(logPath, "utf-8");
        } catch {
          // Log file not written yet. Keep polling.
        }
        const established = TUNNEL_ESTABLISHED_RE.exec(logText);
        if (established) {
          publicUrl = established[1];
          return true;
        }
        const adoptedMatch = ADOPTED_TUNNEL_RE.exec(logText);
        if (adoptedMatch) {
          publicUrl = adoptedMatch[1];
          adopted = true;
          return true;
        }
        return false;
      },
    });

    if (exitCode !== undefined) {
      let logText = "";
      try {
        logText = readFileSync(logPath, "utf-8");
      } catch {
        // Log file not readable — the summary falls back to none.
      }
      if (holderStops < 1 && (await offerStopNgrokHolder(logText))) {
        adopted = false;
        publicUrl = undefined;
        continue;
      }
      const reason = summarizeStartupFailure(logText);
      console.error(
        `Error (${exitCode ?? "unknown"}): tunnel process exited during startup${reason ? `: ${reason}` : "."}`,
      );
      console.error(`Logs: ${logPath}`);
      process.exit(1);
    }

    if (!ready) {
      console.log(
        `Tunnel is still starting up after ${TUNNEL_BACKGROUND_START_TIMEOUT_MS / 1000}s. Check progress: ${logPath}`,
      );
    } else if (publicUrl) {
      console.log(`Tunnel established: ${publicUrl}`);
    }
    console.log(`Running in background (pid ${child.pid}). Logs: ${logPath}`);
    if (adopted) {
      console.log(adoptedTunnelStopNotice(child.pid));
    } else {
      console.log(`Stop with: ${cliCommandName()} tunnel stop`);
    }
    return;
  }
}

/** The `cadet tunnel stop` flow: stop the recorded tunnel, keep nginx. */
async function stopTunnelFlow(): Promise<void> {
  const record = readRootProcesses().tunnel;
  if (!record) {
    console.log(
      "No Cadet-managed tunnel is recorded. Externally started tunnels must be stopped directly.",
    );
    return;
  }
  const stopped = await stopTunnelProcess();
  console.log(
    stopped
      ? "Tunnel stopped. nginx and the saved domain are unchanged."
      : "No running tunnel found; cleared stale tunnel state.",
  );
}

export const tunnel = Object.assign(
  async function tunnel(): Promise<void> {
    const subcommand = process.argv[3];
    if (subcommand === "stop") {
      const args = process.argv.slice(4);
      if (args.includes("--help") || args.includes("-h")) {
        console.log(`Usage: ${cliCommandName()} tunnel stop`);
        console.log(
          "Stop the recorded Cadet-managed tunnel, keeping nginx and the saved domain.",
        );
        return;
      }
      if (args.length > 0)
        throw new Error(`Usage: ${cliCommandName()} tunnel stop`);
      await stopTunnelFlow();
      return;
    }
    if (subcommand === "status") {
      await printRootProcessDetail("tunnel");
      return;
    }
    if (subcommand !== "start") {
      if (
        subcommand !== undefined &&
        subcommand !== "--help" &&
        subcommand !== "-h"
      ) {
        console.error(`Error: Unknown argument '${subcommand}'.`);
      }
      console.error(
        `Usage: ${cliCommandName()} tunnel start --provider <provider> [options]`,
      );
      console.error(`       ${cliCommandName()} tunnel status`);
      console.error(`       ${cliCommandName()} tunnel stop`);
      process.exit(1);
    }
    const { provider, domain, clearDomain, foreground } = parseArgs();

    if (!foreground) {
      await spawnDetachedTunnel();
      return;
    }

    if (PROVIDER_META[provider].comingSoon) {
      throw cadetTunnelComingSoonError(provider);
    }

    // The tunnel is assistant-agnostic: its only concern is the app server —
    // a machine-level edge that resolves whatever it fronts from the lockfile
    // itself. ensureAppServer starts the edge when it is down and reuses it
    // when up; the tunnel fronts the port it reports.

    if (clearDomain) {
      clearReservedDomain();
      console.log("Cleared the saved reserved domain.");
    }

    await ensureNginxForEdge();

    let edge: AppServer;
    try {
      // The edge resolves the assistant it fronts (and the gateway to proxy)
      // from the lockfile itself — no per-assistant threading here.
      edge = await ensureAppServer();
    } catch (err) {
      console.error(
        `Error: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }

    console.log(
      `${edge.started ? "Started" : "Reusing"} the nginx edge on 127.0.0.1:${edge.port}.`,
    );

    const baseTunnelOpts = {
      port: edge.port,
    };

    await runProviderTunnel(provider, {
      ...baseTunnelOpts,
      ...(domain ? { domain } : {}),
    });
  },
  { description: "Start or stop a tunnel in front of the app server" },
);
