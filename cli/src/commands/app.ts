import { loadAllAssistants } from "../lib/assistant-config";
import { getDefaultWorkspaceDir } from "../lib/ingress-config.js";
import {
  ensureTunnelEdge,
  isIngressRunning,
  readIngressState,
  stopIngressNginx,
  type TunnelEdge,
} from "../lib/nginx-ingress.js";
import {
  ensureNginxForEdge,
  resolveLocalTunnelTarget,
  toLocalTunnelTarget,
} from "../lib/tunnel.js";
import { cliCommand } from "../lib/cli-name.js";

function printAppHelp(): void {
  console.log(
    `Usage: ${cliCommand()} app start [options]\n       ${cliCommand()} app stop`,
  );
  console.log("");
  console.log("Start or stop the local app edge (nginx).");
  console.log(
    "The edge serves the app shell + web UI and proxies the gateway's /v1 and",
  );
  console.log(
    "webhook routes; it is the TLS tunnel's target, and runs on loopback only.",
  );
  console.log("");
  console.log(
    "It fronts the active (or sole local) assistant's gateway; a tunnel is",
  );
  console.log(`separate — bring one up with \`${cliCommand()} tunnel start\`.`);
  process.exit(0);
}

/** `cadet app start`: bring the nginx edge up for the active local assistant. */
async function startAppEdge(): Promise<void> {
  await ensureNginxForEdge();

  const { entry, gatewayPort, workspaceDir } = resolveLocalTunnelTarget();

  let edge: TunnelEdge;
  try {
    edge = await ensureTunnelEdge({
      assistantId: entry.assistantId,
      workspaceDir,
      gatewayPort,
    });
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  console.log(
    `${edge.started ? "Started" : "Reusing"} the app edge on 127.0.0.1:${edge.port} (app shell + remote web + webhooks).`,
  );
  console.log(`Stop with: ${cliCommand()} app stop`);
}

/**
 * Workspaces that could hold a running edge: every locally reachable
 * assistant's own, then the default one container assistants share. Usually
 * exactly one is live.
 */
function candidateEdgeWorkspaces(): string[] {
  const workspaces: string[] = [];
  for (const entry of loadAllAssistants()) {
    const target = toLocalTunnelTarget(entry);
    if (target && !workspaces.includes(target.workspaceDir)) {
      workspaces.push(target.workspaceDir);
    }
  }
  if (!workspaces.includes(getDefaultWorkspaceDir())) {
    workspaces.push(getDefaultWorkspaceDir());
  }
  return workspaces;
}

/** `cadet app stop`: take the nginx edge down. */
async function stopAppEdge(): Promise<void> {
  let stoppedAny = false;
  for (const workspaceDir of candidateEdgeWorkspaces()) {
    if (!isIngressRunning(workspaceDir)) continue;
    const port = readIngressState(workspaceDir)?.listenPort;
    if (await stopIngressNginx(workspaceDir)) {
      stoppedAny = true;
      console.log(`Stopped the app edge on 127.0.0.1:${port ?? "?"}.`);
    } else {
      console.error(
        `Error: could not stop the app edge on 127.0.0.1:${port ?? "?"}. Check the nginx log: ${workspaceDir}/data/logs/nginx-ingress.log`,
      );
      process.exit(1);
    }
  }
  if (!stoppedAny) {
    console.log("No app edge is running.");
  }
}

export const app = Object.assign(
  async function app(): Promise<void> {
    const subcommand = process.argv[3];
    if (subcommand === "--help" || subcommand === "-h" || !subcommand) {
      printAppHelp();
      return;
    }
    if (subcommand === "start") return startAppEdge();
    if (subcommand === "stop") return stopAppEdge();
    console.error(`Error: Unknown argument '${subcommand}'.`);
    printAppHelp();
  },
  { description: "Start or stop the local app edge (nginx)" },
);
