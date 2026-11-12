import {
  cliCommand,
  DEFAULT_EXEC_TIMEOUT,
  execCommand,
  getCloudUrl,
  type ServiceName,
} from "@mycadet/local-mode";

import { red } from "../lib/color";

import { resolveAssistant } from "../lib/assistant-config";

import {
  execAppleContainer,
  sshAppleContainer,
} from "../lib/remotes/apple-container.js";
import {
  interactiveSession,
  nonInteractiveExec,
  shellEscapeArgs,
} from "../lib/terminal-session";

const SERVICE_ALIASES: Record<string, ServiceName> = {
  assistant: "assistant",
  mycadet: "assistant",
  gateway: "gateway",
  "cadet-gateway": "gateway",
  "credential-executor": "credential-executor",
  "cadet-credential-executor": "credential-executor",
};

function normalizeService(raw: string): ServiceName {
  const normalized = SERVICE_ALIASES[raw];
  if (!normalized) {
    console.error(
      red(
        `Unknown service '${raw}'. Valid services: assistant, gateway, credential-executor`,
      ),
    );
    process.exit(1);
  }
  return normalized;
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
        `Usage: ${cliCommand()} exec [<name>] [--service <svc>] [-it] -- <command...>`,
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
      console.log(
        "  --service <svc>     Target service, defaults to assistant",
      );
      console.log(
        "  -it                 Interactive mode with TTY (like docker exec -it)",
      );
      console.log(
        "  --timeout <secs>    Timeout in seconds — default 30, 0 = no timeout",
      );
      console.log("  --verbose           Show debug output");
      console.log("");
      console.log("Services:");
      console.log("  assistant");
      console.log("  gateway");
      console.log("  credential-executor");
      console.log("");
      console.log("Examples:");
      console.log(`  ${cliCommand()} exec -- ls -la /workspace`);
      console.log(`  ${cliCommand()} exec -- cat /workspace/NOW.md`);
      console.log(`  ${cliCommand()} exec -it -- /bin/bash`);
      console.log(
        `  ${cliCommand()} exec --service gateway -- cat /tmp/gateway.log`,
      );
      process.exit(0);
    }

    if (dashDashIndex === -1) {
      console.error(
        red(
          "Error: missing '--' separator before command.\n" +
            `Usage: ${cliCommand()} exec [<name>] -- <command...>`,
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
    let verbose = false;
    let timeoutMs = DEFAULT_EXEC_TIMEOUT;

    for (let i = 0; i < preArgs.length; i++) {
      if (preArgs[i] === "--service" && preArgs[i + 1]) {
        serviceRaw = preArgs[++i];
      } else if (preArgs[i] === "-it" || preArgs[i] === "-ti") {
        interactive = true;
      } else if (preArgs[i] === "--timeout" && preArgs[i + 1]) {
        const secs = Number(preArgs[++i]);
        if (!Number.isFinite(secs) || secs < 0) {
          console.error(red("Error: --timeout must be a non-negative number."));
          process.exit(1);
        }
        timeoutMs = secs === 0 ? 0 : secs * 1000;
      } else if (preArgs[i] === "--verbose") {
        verbose = true;
      } else if (!preArgs[i].startsWith("-")) {
        nameArg = preArgs[i];
      }
    }

    const service = normalizeService(serviceRaw);

    const entry = resolveAssistant(nameArg);

    if (!entry) {
      if (nameArg) {
        console.error(
          red(`No assistant instance found with name '${nameArg}'.`),
        );
      } else {
        console.error(
          red("No assistant instance found. Run `cadet hatch` first."),
        );
      }
      process.exit(1);
    }

    // Every cloud routes inside the exec operation; the CLI only supplies
    // the two transports that live here (apple-container's ssh, cloud's
    // terminal session).
    const result = await execCommand(
      entry,
      { command, service, interactive, verbose, timeoutMs },
      {
        appleContainer: async (entry, opts, fullServiceName) => {
          if (opts.interactive) {
            await sshAppleContainer(entry, opts.command, fullServiceName);
          } else {
            await execAppleContainer(entry, opts.command, fullServiceName);
          }
        },
        cloud: async (entry, opts, token) => {
          const assistant = {
            assistantId: entry.assistantId,
            token,
            cloudUrl: getCloudUrl(),
          };
          const serviceParam =
            opts.service === "assistant" ? undefined : opts.service;
          if (opts.interactive) {
            await interactiveSession(
              assistant,
              shellEscapeArgs(opts.command),
              serviceParam,
            );
            return;
          }
          // Non-interactive: sentinel-based output capture; exits with the
          // command's own exit code.
          await nonInteractiveExec(assistant, opts.command, {
            verbose: opts.verbose,
            timeoutMs: opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT,
            service: serviceParam,
          });
        },
      },
    );
    if ("error" in result) {
      console.error(red(`Error: ${result.error}`));
      process.exitCode = result.status;
    } else {
      process.exitCode = result.code;
    }
  },
  { description: "Execute a command inside an assistant's container" },
);
