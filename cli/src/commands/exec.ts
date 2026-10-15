import { existsSync } from "fs";
import { join } from "path";

import { spawn } from "child_process";
import { red } from "../lib/color";

import { resolveAssistant } from "../lib/assistant-config";
import { dockerResourceNames } from "../lib/docker";
import type { ServiceName } from "../lib/docker";
import { execAppleContainer } from "../lib/exec-apple-container";
import { sshAppleContainer } from "../lib/ssh-apple-container";

const SERVICE_ALIASES: Record<string, ServiceName> = {
  assistant: "assistant",
  "mycadet": "assistant",
  gateway: "gateway",
  "cadet-gateway": "gateway",
  "credential-executor": "credential-executor",
  "cadet-credential-executor": "credential-executor",
};

function normalizeService(raw: string): ServiceName {
  const normalized = SERVICE_ALIASES[raw];
  if (!normalized) {
    console.error(
      red(`Unknown service '${raw}'. Valid services: assistant, gateway, credential-executor`),
    );
    process.exit(1);
  }
  return normalized;
}

function resolveDockerContainer(
  instanceName: string,
  service: ServiceName,
): string {
  const res = dockerResourceNames(instanceName);
  switch (service) {
    case "assistant":
      return res.assistantContainer;
    case "gateway":
      return res.gatewayContainer;
    case "credential-executor":
      return res.cesContainer;
  }
}

export const exec = Object.assign(
  async function exec(): Promise<void> {
  const rawArgs = process.argv.slice(3);

  // Only check for help flags before the -- separator so that
  // `cadet exec -- curl --help` passes through correctly.
  const dashDashIndex = rawArgs.indexOf("--");
  const preArgs =
    dashDashIndex === -1 ? rawArgs : rawArgs.slice(0, dashDashIndex);

  if (
    preArgs.includes("--help") ||
    preArgs.includes("-h") ||
    rawArgs.length === 0
  ) {
    console.log(
      "Usage: cadet exec [<name>] [--service <svc>] [-it] -- <command...>",
    );
    console.log("");
    console.log("Execute a command inside an assistant's container.");
    console.log("");
    console.log("Arguments:");
    console.log(
      "  <name>              Name of the assistant, defaults to active",
    );
    console.log(
      "  <command...>        Command and arguments to run (after --)",
    );
    console.log("");
    console.log("Options:");
    console.log("  --service <svc>     Target service, defaults to assistant");
    console.log(
      "  -it                 Interactive mode with TTY (like docker exec -it)",
    );
    console.log("");
    console.log("Services:");
    console.log("  assistant");
    console.log("  gateway");
    console.log("  credential-executor");
    console.log("");
    console.log("Examples:");
    console.log("  cadet exec -- ls -la /workspace");
    console.log("  cadet exec -- cat /workspace/NOW.md");
    console.log("  cadet exec -it -- /bin/bash");
    console.log("  cadet exec --service gateway -- cat /tmp/gateway.log");
    process.exit(0);
  }

  if (dashDashIndex === -1) {
    console.error(
      red(
        "Error: missing '--' separator before command.\n" +
          "Usage: cadet exec [<name>] -- <command...>",
      ),
    );
    process.exit(1);
  }

  const command = rawArgs.slice(dashDashIndex + 1);

  if (command.length === 0) {
    console.error(red("Error: no command specified after '--'."));
    process.exit(1);
  }

  let nameArg: string | undefined;
  let serviceRaw = "assistant";
  let interactive = false;

  for (let i = 0; i < preArgs.length; i++) {
    if (preArgs[i] === "--service" && preArgs[i + 1]) {
      serviceRaw = preArgs[++i];
    } else if (preArgs[i] === "-it" || preArgs[i] === "-ti") {
      interactive = true;
    } else if (!preArgs[i].startsWith("-")) {
      nameArg = preArgs[i];
    }
  }

  const service = normalizeService(serviceRaw);

  const entry = resolveAssistant(nameArg);

  if (!entry) {
    if (nameArg) {
      console.error(red(`No assistant instance found with name '${nameArg}'.`));
    } else {
      console.error(red("No assistant instance found. Run `cadet hatch` first."));
    }
    process.exit(1);
  }

  const cloud = entry.cloud;

  if (cloud === "local") {
    const instanceDir = entry.resources?.instanceDir;
    if (!instanceDir) {
      console.error(
        red(
          `Error: assistant '${entry.assistantId}' has no local instance directory recorded.`,
        ),
      );
      process.exit(1);
    }

    const workspaceDir = join(instanceDir, "workspace");
    const socketPath = join(workspaceDir, "assistant.sock");
    if (!existsSync(socketPath)) {
      console.error(
        red(
          `Error: the assistant runtime is not reachable (no socket at ${socketPath}).`,
        ),
      );
      console.error(
        red("Start it with `cadet wake`, or check `cadet ps` for its status."),
      );
      process.exit(1);
    }

    const child = spawn(command[0], command.slice(1), {
      stdio: "inherit",
      windowsHide: true,
      env: {
        ...process.env,
        CADET_WORKSPACE_DIR: workspaceDir,
      },
    });
    await new Promise<void>((resolve) => {
      child.on("close", (code) => {
        process.exitCode = code ?? 0;
        resolve();
      });
      child.on("error", (err) => {
        console.error(red(`Error: ${err.message}`));
        process.exitCode = 1;
        resolve();
      });
    });
    return;
  }

  if (cloud === "apple-container") {
    const fullServiceName = `cadet-${service}`;
    if (interactive) {
      await sshAppleContainer(entry, command, fullServiceName);
    } else {
      await execAppleContainer(entry, command, fullServiceName);
    }
    return;
  }

  if (cloud === "docker") {
    const container = resolveDockerContainer(entry.assistantId, service);
    const dockerArgs = interactive
      ? ["exec", "-it", container, ...command]
      : ["exec", container, ...command];

    const child = spawn("docker", dockerArgs, {
      stdio: "inherit",
      windowsHide: true,
    });
    await new Promise<void>((resolve, reject) => {
      child.on("close", (code) => {
        if (code === 0) resolve();
        else {
          process.exitCode = code ?? 1;
          resolve();
        }
      });
      child.on("error", reject);
    });
    return;
  }

  console.error(red(`Error: 'cadet exec' is not supported for ${cloud} instances.`));
  process.exit(1);
},
  { description: "Execute a command inside an assistant's container" },
);

