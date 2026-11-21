import { Command, InvalidArgumentError } from "commander";

import {
  TUNNEL_PROVIDERS,
  type TunnelProviderName,
} from "@mycadet/service-contracts/ingress";

import { readRootProcesses } from "../lib/assistant-config";
import { ensureAppServer, type AppServer } from "../lib/servers/common.js";
import { STALE_CLI_UPDATE_HINT } from "../lib/stale-cli-hint.js";
import {
  DEFAULT_TUNNEL_PROVIDER,
  PROVIDER_META,
  clearReservedDomain,
  isTunnelProvider,
  providerSupportsReservedDomain,
  restartTunnel,
  runProviderTunnel,
  stopTunnelProcess,
} from "../lib/tunnel.js";
import { cadetTunnelComingSoonError } from "../lib/tunnels/cadet.js";
import { cliCommand } from "@mycadet/local-mode";
import { printRootProcessDetail } from "./ps.js";

// The accepted `--provider` values ARE the shared registry, so validation
// here cannot drift from what the workspace config accepts.

function parseProvider(value: string): TunnelProviderName {
  if (!isTunnelProvider(value)) {
    throw new InvalidArgumentError(
      `unknown tunnel provider '${value}'. Valid providers: ${TUNNEL_PROVIDERS.join(", ")}. If this provider is documented, ${STALE_CLI_UPDATE_HINT}`,
    );
  }
  return value;
}

/** The `cadet tunnel start` flow: ensure the edge, run the provider tunnel. */
async function startTunnelFlow(
  opts: {
    provider?: TunnelProviderName;
    domain?: string;
    clearDomain?: boolean;
  },
  command: Command,
): Promise<void> {
  let provider = opts.provider;
  if (provider === undefined) {
    provider = DEFAULT_TUNNEL_PROVIDER;
    console.log(`Using the default provider: ${provider}.`);
  }

  const domain = opts.domain ?? null;
  const clearDomain = opts.clearDomain ?? false;

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

  // No positionals exist anymore — the scan catches the leftover habit of
  // naming an assistant here.
  const positional = command.args[0];
  if (positional !== undefined) {
    console.error(
      `Error: Unknown argument '${positional}'. ${cliCommand()} tunnel takes no assistant name — it fronts the active assistant; use \`${cliCommand()} tunnel start\` or \`${cliCommand()} tunnel stop\`.`,
    );
    process.exit(1);
  }

  if (PROVIDER_META[provider].comingSoon) {
    throw cadetTunnelComingSoonError(provider);
  }

  // The tunnel is assistant-agnostic: its only concern is the app server —
  // a machine-level server that resolves whatever it fronts from the
  // lockfile itself. ensureAppServer starts it when it is down and reuses
  // it when up; the tunnel fronts the port it reports.

  if (clearDomain) {
    clearReservedDomain();
    console.log("Cleared the saved reserved domain.");
  }

  let edge: AppServer;
  try {
    // The app server resolves the assistant it fronts (and the gateway to
    // proxy) from the lockfile itself — no per-assistant threading here.
    edge = await ensureAppServer();
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  console.log(
    `${edge.started ? "Started" : "Reusing"} the app server on 127.0.0.1:${edge.port}.`,
  );

  await runProviderTunnel(provider, { ...(domain ? { domain } : {}) });
}

/** The `cadet tunnel restart` flow: bounce the tunnel, keep the app server. */
async function restartTunnelFlow(): Promise<void> {
  const restarted = await restartTunnel();
  console.log(`Tunnel restarted: ${restarted.publicUrl}`);
}

/** The `cadet tunnel stop` flow: stop the recorded tunnel, keep the app server. */
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
      ? "Tunnel stopped. The app server and the saved domain are unchanged."
      : "No running tunnel found; cleared stale tunnel state.",
  );
}

/** The provider reach/install notes the bespoke help used to carry. */
function providersSection(): string {
  const lines: string[] = ["Providers:"];
  for (const name of TUNNEL_PROVIDERS) {
    const meta = PROVIDER_META[name];
    lines.push(`  ${name.padEnd(12)}${meta.reach}`);
    lines.push(`  ${" ".repeat(12)}${meta.install}`);
    for (const note of meta.notes ?? []) {
      lines.push(`  ${" ".repeat(12)}${note}`);
    }
  }
  lines.push("");
  lines.push("Examples:");
  lines.push(
    `  $ ${cliCommand()} tunnel start --provider ${DEFAULT_TUNNEL_PROVIDER}`,
  );
  const domainExample = PROVIDER_META[DEFAULT_TUNNEL_PROVIDER].domainExample;
  if (domainExample) {
    lines.push(
      `  $ ${cliCommand()} tunnel start --provider ${DEFAULT_TUNNEL_PROVIDER} --domain ${domainExample}`,
    );
    lines.push(
      `  $ ${cliCommand()} tunnel start --provider ${DEFAULT_TUNNEL_PROVIDER} --clear-domain`,
    );
  }
  lines.push(`  $ ${cliCommand()} tunnel start --provider cloudflare`);
  lines.push(`  $ ${cliCommand()} tunnel stop`);
  return lines.join("\n");
}

/**
 * The `cadet tunnel` command tree — commander owns the subcommand dispatch
 * and flag parsing (the hand-rolled argv[3] switch was the #881 bug class:
 * `tunnel start --help` could not show the other subcommands); this module
 * keeps the execute layer.
 */
export function registerTunnelCommand(program: Command): void {
  const tunnel = program
    .command("tunnel")
    .description("Start or stop a tunnel in front of the app server");

  tunnel
    .command("start")
    .description("Front the locally running assistant with an HTTPS tunnel")
    .option(
      "--provider <provider>",
      `Tunnel provider: ${TUNNEL_PROVIDERS.join(", ")} — default ${DEFAULT_TUNNEL_PROVIDER}`,
      parseProvider,
    )
    .option(
      "--domain <domain>",
      "Reserved domain to bind, for providers that support one. Saved to the workspace config so restarts reuse it.",
    )
    .option(
      "--clear-domain",
      "Clear the saved reserved domain (same providers) and tunnel without one. Cannot be combined with --domain.",
    )
    .allowExcessArguments(true)
    .addHelpText(
      "after",
      `
The tunnel URL is saved to the workspace config as the ingress base URL, and shared with every locally reachable assistant's gateway when the tunnel establishes.

How far that URL reaches depends on the provider; omit --provider for the default. A tailscale tunnel is reachable only from your own tailnet; webhook integrations need a public tunnel.

The tunnel always fronts the local app server, which is started automatically. The tunnel runs in the background: the command returns after printing the public URL, and logs stream to tunnel.log in the CLI log directory. Stop the tunnel with \`${cliCommand()} tunnel stop\`, except when it adopted an already-running tunnel (started outside this command): killing the supervisor then leaves that tunnel running.

${providersSection()}`,
    )
    .action(startTunnelFlow);

  tunnel
    .command("stop")
    .description(
      "Stop the recorded Cadet-managed tunnel, keeping the app server and the saved domain",
    )
    .action(stopTunnelFlow);

  tunnel
    .command("restart")
    .description("Bounce the tunnel, keeping the app server")
    .action(restartTunnelFlow);

  tunnel
    .command("status")
    .description("Show the recorded tunnel process")
    .action(async () => {
      await printRootProcessDetail("tunnel");
    });
}

/**
 * Compat runner for the tunnel suite: the tests set process.argv and call
 * `tunnel()` the way the pre-commander entry did. Builds the tunnel subtree
 * standalone and parses the argv after the command word.
 */
export const tunnel = Object.assign(
  async function tunnel(): Promise<void> {
    const program = new Command();
    program.name(cliCommand());
    registerTunnelCommand(program);
    await program.parseAsync(["tunnel", ...process.argv.slice(3)], {
      from: "user",
    });
  },
  { description: "Start or stop a tunnel in front of the app server" },
);
