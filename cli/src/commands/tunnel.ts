import {
  TUNNEL_PROVIDERS,
  type TunnelProviderName,
} from "@mycadet/service-contracts/ingress";

import { readRootProcesses } from "../lib/assistant-config";
import { ensureAppServer, type AppServer } from "../lib/servers/nginx.js";
import { STALE_CLI_UPDATE_HINT } from "../lib/stale-cli-hint.js";
import {
  DEFAULT_TUNNEL_PROVIDER,
  PROVIDER_META,
  clearReservedDomain,
  ensureNginxForEdge,
  providerSupportsReservedDomain,
  runProviderTunnel,
  stopTunnelProcess,
} from "../lib/tunnel.js";
import { cadetTunnelComingSoonError } from "../lib/tunnels/cadet.js";
import { cliCommand } from "@mycadet/local-mode";
import { printRootProcessDetail } from "./ps.js";

// The accepted `--provider` values ARE the shared registry, so validation
// here cannot drift from what the workspace config accepts.

interface TunnelArgs {
  provider: TunnelProviderName;
  domain: string | null;
  clearDomain: boolean;
}

function parseArgs(): TunnelArgs {
  // argv[3] is the `start` subcommand — the entrypoint dispatches on it.
  const args = process.argv.slice(4);
  let provider: TunnelProviderName | null = null;
  let domain: string | null = null;
  let clearDomain = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      console.log(
        `Usage: ${cliCommand()} tunnel start --provider <provider> [options]\n       ${cliCommand()} tunnel stop`,
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
        "                                one. Saved to the workspace config so `${cliCommand()} wake` restores",
      );
      console.log("                                reuse it.");
      console.log(
        "  --clear-domain                Clear the saved reserved domain (same providers) and",
      );
      console.log(
        "                                tunnel without one. Cannot be combined with --domain.",
      );
      console.log(
        "The tunnel runs in the background: the command returns after printing",
      );
      console.log(
        "the public URL, and logs stream to tunnel.log in the CLI log directory.",
      );
      console.log(
        `Stop the tunnel with \`${cliCommand()} tunnel stop\`, except when it`,
      );
      console.log(
        "adopted an already-running tunnel (started outside this command):",
      );
      console.log("killing the supervisor then leaves that tunnel running.");
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
        `  $ ${cliCommand()} tunnel start --provider ${DEFAULT_TUNNEL_PROVIDER}`,
      );
      const domainExample =
        PROVIDER_META[DEFAULT_TUNNEL_PROVIDER].domainExample;
      if (domainExample) {
        console.log(
          `  $ ${cliCommand()} tunnel start --provider ${DEFAULT_TUNNEL_PROVIDER} --domain ${domainExample}`,
        );
        console.log(
          `  $ ${cliCommand()} tunnel start --provider ${DEFAULT_TUNNEL_PROVIDER} --clear-domain`,
        );
      }
      console.log(`  $ ${cliCommand()} tunnel start --provider cloudflare`);
      console.log(`  $ ${cliCommand()} tunnel stop`);
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
      `Error: Unknown argument '${positional}'. ${cliCommand()} tunnel takes no assistant name — it fronts the active assistant; use \`${cliCommand()} tunnel start\` or \`${cliCommand()} tunnel stop\`.`,
    );
    process.exit(1);
  }

  return { provider, domain, clearDomain };
}

/** A tunnelable assistant plus the gateway port and workspace the edge fronts. */
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
        console.log(`Usage: ${cliCommand()} tunnel stop`);
        console.log(
          "Stop the recorded Cadet-managed tunnel, keeping nginx and the saved domain.",
        );
        return;
      }
      if (args.length > 0)
        throw new Error(`Usage: ${cliCommand()} tunnel stop`);
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
        `Usage: ${cliCommand()} tunnel start --provider <provider> [options]`,
      );
      console.error(`       ${cliCommand()} tunnel status`);
      console.error(`       ${cliCommand()} tunnel stop`);
      process.exit(1);
    }
    const { provider, domain, clearDomain } = parseArgs();

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
