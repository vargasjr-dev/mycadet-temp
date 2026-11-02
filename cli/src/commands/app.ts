import {
  getAppServerPaths,
  isAppServerRunning,
  readAppServerState,
  stopAppServer,
  cliCommand,
} from "@mycadet/local-mode";
import { ensureAppServer, type AppServer } from "../lib/servers/app-server.js";
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

/** `cadet app start`: bring the app server up for the active local assistant. */
async function startAppServer(): Promise<void> {
  let server: AppServer;
  try {
    server = await ensureAppServer();
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  console.log(
    `${server.started ? "Started" : "Reusing"} the app server on 127.0.0.1:${server.port}.`,
  );
  console.log(`Stop with: ${cliCommand()} app stop`);
}

/** `cadet app stop`: take the app server down. */
async function stopAppServerCommand(): Promise<void> {
  // One machine-level app server: its pid/state live under the XDG data
  // dir, not any assistant workspace, so there is exactly one candidate.
  if (!isAppServerRunning()) {
    console.log("No app server is running.");
    return;
  }
  const port = readAppServerState()?.listenPort;
  if (await stopAppServer()) {
    console.log(`Stopped the app server on 127.0.0.1:${port ?? "?"}.`);
  } else {
    console.error(
      `Error: could not stop the app server on 127.0.0.1:${port ?? "?"}. Check the log: ${getAppServerPaths().logPath}`,
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
    if (subcommand === "start") return startAppServer();
    if (subcommand === "stop") return stopAppServerCommand();
    if (subcommand === "status") {
      await printRootProcessDetail("app");
      return;
    }
    console.error(`Error: Unknown argument '${subcommand}'.`);
    printAppHelp();
  },
  { description: "Start or stop the local app server" },
);
