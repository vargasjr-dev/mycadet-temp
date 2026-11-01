import {
  ensureAppServer,
  getIngressPaths,
  isIngressRunning,
  readIngressState,
  stopIngressNginx,
  type AppServer,
} from "../lib/servers/nginx.js";
import { ensureNginxForEdge } from "../lib/tunnel.js";
import { cliCommandName as cliCommand } from "@mycadet/local-mode";
import { printRootProcessDetail } from "./ps.js";

function printAppHelp(): void {
  console.log(
    `Usage: ${cliCommand()} app start [options]\n       ${cliCommand()} app stop\n       ${cliCommand()} app status`,
  );
  console.log("");
  console.log(
    "The App server hosts the assistant-agnostic frontend bundle, is the home",
  );
  console.log(
    "for assistant management commands, and proxies all assistant-specific",
  );
  console.log("APIs & webhooks to the correct Cadet.");
  console.log("");
  console.log(
    `The App server is spun up automatically as part of the \`${cliCommand()} tunnel start\` command.`,
  );
  process.exit(0);
}

/** `cadet app start`: bring the nginx edge up for the active local assistant. */
async function startAppEdge(): Promise<void> {
  await ensureNginxForEdge();

  let edge: AppServer;
  try {
    edge = await ensureAppServer();
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  console.log(
    `${edge.started ? "Started" : "Reusing"} the app edge on 127.0.0.1:${edge.port}.`,
  );
  console.log(`Stop with: ${cliCommand()} app stop`);
}

/** `cadet app stop`: take the nginx edge down. */
async function stopAppEdge(): Promise<void> {
  // One machine-level edge: its conf/pid/state live under the XDG data dir,
  // not any assistant workspace, so there is exactly one candidate.
  if (!isIngressRunning()) {
    console.log("No app edge is running.");
    return;
  }
  const port = readIngressState()?.listenPort;
  if (await stopIngressNginx()) {
    console.log(`Stopped the app edge on 127.0.0.1:${port ?? "?"}.`);
  } else {
    console.error(
      `Error: could not stop the app edge on 127.0.0.1:${port ?? "?"}. Check the nginx log: ${getIngressPaths().logPath}`,
    );
    process.exit(1);
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
    if (subcommand === "status") {
      await printRootProcessDetail("app");
      return;
    }
    console.error(`Error: Unknown argument '${subcommand}'.`);
    printAppHelp();
  },
  { description: "Start or stop the local app edge (nginx)" },
);
