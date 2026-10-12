import { isCloudHome } from "../lib/cloud-values.js";
import { readFileSync } from "node:fs";
import { join } from "path";

import {
  TUNNEL_PROVIDERS,
  type TunnelProviderName,
} from "@mycadet/service-contracts/ingress";

import {
  formatAssistantReference,
  loadAllAssistants,
  resolveTargetAssistant,
  type AssistantEntry,
} from "../lib/assistant-config";
import { parseAssistantTargetArg } from "../lib/assistant-target-args.js";
import { relaunchDetached } from "../lib/detached-process.js";
import {
  getDefaultWorkspaceDir,
  isLocalContainerEntry,
  parseGatewayPortFromEntryUrls,
} from "../lib/ingress-config.js";
import {
  ensureTunnelEdge,
  getNginxVersion,
  type TunnelEdge,
} from "../lib/nginx-ingress.js";
import { ensureBinaryInstalled } from "../lib/ensure-binary.js";
import { STALE_CLI_UPDATE_HINT } from "../lib/stale-cli-hint.js";
import {
  ADOPTED_TUNNEL_RE,
  DEFAULT_TUNNEL_PROVIDER,
  PROVIDER_META,
  adoptedTunnelStopNotice,
  cadetTunnelComingSoonError,
  clearReservedDomain,
  hasWebhookIntegrationsConfigured,
  providerSupportsReservedDomain,
  runProviderTunnel,
} from "../lib/tunnel.js";

// The accepted `--provider` values ARE the shared registry, so validation
// here cannot drift from what the workspace config accepts.

interface TunnelArgs {
  assistantName: string | null;
  provider: TunnelProviderName;
  domain: string | null;
  clearDomain: boolean;
  detach: boolean;
}

const FLAGS_WITH_VALUES = ["--provider", "--domain"] as const;

function parseArgs(): TunnelArgs {
  const args = process.argv.slice(3);
  let provider: TunnelProviderName | null = null;
  let domain: string | null = null;
  let clearDomain = false;
  let detach = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: cadet tunnel [<name>] --provider <provider> [options]",
      );
      console.log("");
      console.log("Front a locally running assistant with an HTTPS tunnel.");
      console.log(
        "The tunnel URL is saved to the workspace config as the ingress base URL.",
      );
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
      console.log("Arguments:");
      console.log(
        "  <name>                        Name of the assistant, defaults to active or only local",
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
        "                                one. Saved to the workspace config so `cadet wake` restores",
      );
      console.log("                                reuse it.");
      console.log(
        "  --clear-domain                Clear the saved reserved domain (same providers) and",
      );
      console.log(
        "                                tunnel without one. Cannot be combined with --domain.",
      );
      console.log(
        `  -d, --detach                  Run the tunnel in the background. Waits up to ${TUNNEL_BACKGROUND_START_TIMEOUT_MS / 1000}s for the`,
      );
      console.log(
        "                                initial established/failed status before returning; logs go to",
      );
      console.log(
        "                                the CLI log directory. Stop it with `kill <pid>`, except when it",
      );
      console.log(
        "                                adopted an already-running tunnel (started outside this",
      );
      console.log(
        "                                command): killing the supervisor then leaves that tunnel running.",
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
      console.log(`  $ cadet tunnel --provider ${DEFAULT_TUNNEL_PROVIDER}`);
      const domainExample =
        PROVIDER_META[DEFAULT_TUNNEL_PROVIDER].domainExample;
      if (domainExample) {
        console.log(
          `  $ cadet tunnel --provider ${DEFAULT_TUNNEL_PROVIDER} --domain ${domainExample}`,
        );
        console.log(
          `  $ cadet tunnel --provider ${DEFAULT_TUNNEL_PROVIDER} --clear-domain`,
        );
      }
      console.log("  $ cadet tunnel --provider cloudflare");
      console.log("  $ cadet tunnel my-assistant --provider tailscale");
      console.log(
        `  $ cadet tunnel --provider ${DEFAULT_TUNNEL_PROVIDER} --detach`,
      );
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
    } else if (arg === "-d" || arg === "--detach") {
      detach = true;
    } else if (arg.startsWith("-")) {
      console.error(`Error: Unknown option '${arg}'.`);
      process.exit(1);
    }
  }

  // Joins all positionals so unquoted multi-word display names resolve as one
  // identifier (cli/AGENTS.md "Assistant targeting convention").
  const assistantName =
    parseAssistantTargetArg(args, FLAGS_WITH_VALUES) ?? null;

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

  return { assistantName, provider, domain, clearDomain, detach };
}

/** A tunnelable assistant plus the gateway port and workspace the edge fronts. */
interface LocalTunnelTarget {
  entry: AssistantEntry;
  gatewayPort: number;
  workspaceDir: string;
}

/**
 * Map an entry to its local tunnel target, or null when it has no locally
 * reachable gateway (e.g. cloud-hosted). Entries with `resources` carry
 * their own gateway port and instance workspace. Local container entries
 * (docker, apple-container) run locally without host resources: their gateway
 * port comes from localUrl/runtimeUrl and their ingress state lives in the
 * default workspace.
 */
function toLocalTunnelTarget(entry: AssistantEntry): LocalTunnelTarget | null {
  if (entry.resources) {
    return {
      entry,
      gatewayPort: entry.resources.gatewayPort,
      workspaceDir: join(entry.resources.instanceDir, "workspace"),
    };
  }
  if (isLocalContainerEntry(entry)) {
    const gatewayPort = parseGatewayPortFromEntryUrls(entry);
    if (gatewayPort !== undefined) {
      return { entry, gatewayPort, workspaceDir: getDefaultWorkspaceDir() };
    }
  }
  return null;
}

function describeUntunnelableEntry(entry: AssistantEntry): string {
  const reference = formatAssistantReference(entry);
  return isCloudHome(entry.cloud)
    ? `Assistant '${reference}' runs on Cadet Cloud and needs no tunnel.`
    : `Assistant '${reference}' has no locally managed runtime to tunnel.`;
}

/**
 * Resolve the assistant whose gateway and workspace the tunnel edge fronts.
 * Tunnels only make sense for assistants with a local gateway; when the
 * resolved entry has none (e.g. the active assistant is cloud-hosted) and
 * no name was given, fall back to the sole local target, otherwise exit with
 * an error naming the local assistants to pass explicitly.
 */
function resolveLocalTunnelTarget(
  assistantName: string | null,
): LocalTunnelTarget {
  const entry = resolveTargetAssistant(assistantName ?? undefined);

  const target = toLocalTunnelTarget(entry);
  if (target) {
    return target;
  }

  const localTargets = loadAllAssistants()
    .map(toLocalTunnelTarget)
    .filter((local): local is LocalTunnelTarget => local !== null);

  if (!assistantName && localTargets.length === 1) {
    console.log(
      `${describeUntunnelableEntry(entry)} Tunneling the local assistant '${formatAssistantReference(localTargets[0].entry)}' instead.`,
    );
    return localTargets[0];
  }

  console.error(describeUntunnelableEntry(entry));
  if (localTargets.length === 0) {
    console.error(
      "No local assistant found to tunnel. Run `cadet hatch` first.",
    );
  } else {
    console.error(
      `Pass a local assistant as the name argument: ${localTargets
        .map((local) => formatAssistantReference(local.entry))
        .join(", ")}.`,
    );
  }
  process.exit(1);
}

/**
 * Decide how the tailnet-only tailscale tunnel may treat the saved ingress base
 * URL, which is also the webhook callback base. Returns true when the run must
 * leave that URL in place and record the tailnet address for pairing only.
 *
 * A tailnet address in the callback base would repoint those callbacks at
 * something external services cannot resolve, so no run replaces it while
 * webhook integrations are configured. The choice of tailscale is always the
 * user's own, so it is honored, with what it does and does not record spelled
 * out.
 */
function guardTailnetOnlyWebhookIngress(workspaceDir: string): boolean {
  if (!hasWebhookIntegrationsConfigured(workspaceDir)) {
    return false;
  }
  console.warn(
    "⚠ Webhook integrations are configured, and the tailscale tunnel is reachable only from your own tailnet, " +
      "so it cannot serve their callbacks. The saved ingress base URL stays as it is and the tailnet URL is " +
      "recorded for device pairing only. For a tunnel those integrations can reach too, run `cadet tunnel --help` " +
      "to see the public providers.",
  );
  return true;
}

// Generous cap so a slow provider handshake (e.g. cloudflared's own ~30s
// quick-tunnel timeout) still counts as a successful, if slow, start.
const TUNNEL_BACKGROUND_START_TIMEOUT_MS = 35_000;
// Matches the "just established" line every provider prints, or the adoption
// line printed when a run adopts an already-running agent's tunnel (captured
// separately since that case does not own the tunnel it adopted).
const TUNNEL_ESTABLISHED_RE = /Tunnel established: (\S+)/;

/**
 * Re-invoke `cadet tunnel` (without `-d`/`--detach`) as a detached background
 * process via `relaunchDetached`, waiting for the child to either print its
 * "Tunnel established" or adopted-tunnel line (readiness) or
 * exit early (failure), so a misconfigured provider still fails loudly in
 * the terminal that ran `-d`.
 *
 * The log filename is scoped to this (parent) process's pid so concurrent
 * `-d` runs (e.g. tunneling two different local assistants at once) don't
 * truncate and read each other's readiness output.
 */
async function spawnDetachedTunnel(): Promise<void> {
  const childArgs: string[] = ["tunnel"];
  for (const arg of process.argv.slice(3)) {
    if (arg === "-d" || arg === "--detach") {
      continue;
    }
    childArgs.push(arg);
  }

  let publicUrl: string | undefined;
  let adopted = false;

  const { child, logPath, ready, exitCode } = await relaunchDetached({
    args: childArgs,
    logFile: `tunnel-${process.pid}.log`,
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
    console.error(
      `Error: tunnel process exited during startup${exitCode !== null ? ` (exit code ${exitCode})` : ""}. Logs: ${logPath}`,
    );
    process.exit(1);
  }

  if (!ready) {
    console.log(
      `Tunnel is still starting up after ${TUNNEL_BACKGROUND_START_TIMEOUT_MS / 1000}s. Check progress: ${logPath}`,
    );
  } else if (publicUrl) {
    console.log(`Tunnel established: ${publicUrl}`);
  }
  console.log(`Running in background, pid ${child.pid}. Logs: ${logPath}`);
  if (adopted) {
    console.log(adoptedTunnelStopNotice(child.pid));
  } else {
    console.log(`Stop with: kill ${child.pid}`);
  }
}

export const tunnel = Object.assign(
  async function tunnel(): Promise<void> {
    const { assistantName, provider, domain, clearDomain, detach } =
      parseArgs();

    if (detach) {
      await spawnDetachedTunnel();
      return;
    }

    if (PROVIDER_META[provider].comingSoon) {
      throw cadetTunnelComingSoonError(provider);
    }

    const { entry, gatewayPort, workspaceDir } =
      resolveLocalTunnelTarget(assistantName);

    const preserveIngressUrl =
      provider === "tailscale" && guardTailnetOnlyWebhookIngress(workspaceDir);

    if (clearDomain) {
      clearReservedDomain();
      console.log("Cleared the saved reserved domain.");
    }

    const nginxVersion = await ensureBinaryInstalled({
      binary: "nginx",
      purpose: "the tunnel edge",
      packages: {
        brew: ["brew", "install", "nginx"],
        "apt-get": ["sudo", "apt-get", "install", "-y", "nginx"],
        dnf: ["sudo", "dnf", "install", "-y", "nginx"],
        pacman: ["sudo", "pacman", "-S", "--noconfirm", "nginx"],
        zypper: ["sudo", "zypper", "install", "-y", "nginx"],
        choco: ["choco", "install", "-y", "nginx"],
      },
      manualHint:
        "See https://nginx.org/en/docs/install.html for how to install, or point NGINX_BIN at an existing binary.",
      probe: getNginxVersion,
    });
    if (!nginxVersion) {
      console.error("Error: nginx is required to run the tunnel edge.");
      process.exit(1);
    }

    let edge: TunnelEdge;
    try {
      edge = await ensureTunnelEdge({
        assistantId: entry.assistantId,
        workspaceDir,
        gatewayPort,
      });
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
      assistantId: entry.assistantId,
      workspaceDir,
    };

    await runProviderTunnel(provider, {
      ...baseTunnelOpts,
      ...(domain ? { domain } : {}),
      ...(preserveIngressUrl ? { preserveIngressUrl } : {}),
    });
  },
  { description: "Create a tunnel for a locally hosted assistant" },
);
