// Direct import — bun embeds this at compile time so it works in compiled binaries.
import cliPkg from "../../package.json";

import {
  cliCommand,
  dockerResourceNames,
  hatchAssistant,
  readCloudToken,
  validateAssistantName,
} from "@mycadet/local-mode";
import { getGatewayUrl } from "@mycadet/local-mode/contract";
import { checkProviderApiKey } from "../lib/api-key-check.js";
import {
  describeLoginError,
  ensureCloudLoginInteractive,
} from "../lib/cloud-login.js";
import {
  collectProviderApiKey,
  promptProviderChoice,
  resolveHatchProvider,
  shouldPromptForHatchProvider,
} from "../lib/provider-secrets.js";
import { green } from "../lib/color";
import { HATCH_ART, HATCHED_EMOJI, VALID_REMOTE_HOSTS } from "../lib/constants";
import type { RemoteHost } from "../lib/constants";
import { logHatchNextSteps } from "../lib/hatch-next-steps.js";
import { printInstanceDetails } from "../lib/instance-details.js";

const DEFAULT_REMOTE: RemoteHost = "local";

interface HatchArgs {
  verbose: boolean;
  name: string | null;
  remote: RemoteHost;
  watch: boolean;
  sourcePath: string | null;
  configValues: Record<string, string>;
  netnsContainer: string | null;
  gatewayPort: number | null;
  assistantCaCert: string | null;
}

function parseArgs(): HatchArgs {
  const args = process.argv.slice(3);
  let verbose = false;
  let name: string | null = null;
  let remote: RemoteHost = DEFAULT_REMOTE;
  let watch = false;
  let sourcePath: string | null = null;
  const configValues: Record<string, string> = {};
  let netnsContainer: string | null = null;
  let gatewayPort: number | null = null;
  let assistantCaCert: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      console.log(`Usage: ${cliCommand()} hatch [options]`);
      console.log("");
      console.log("Create a new assistant instance.");
      console.log("");
      console.log("Options:");
      console.log(
        "  -v, --verbose             Show service startup logs and extended next steps",
      );
      console.log("  --name <name>             Custom name for this assistant");
      console.log(
        "  --remote <host>           Remote host (local, docker, custom, cloud)",
      );
      console.log(
        "  --watch                   Run Cadet in watch mode with hot reload on source changes",
      );
      console.log(
        "  --source <path>           Build images from a local source tree at <path>",
      );
      console.log(
        "  --config <key=value>      Set a workspace config value (repeatable)",
      );
      console.log(
        "  --netns-container <name>  Join an existing container's network namespace instead of creating a per-instance network.",
      );
      console.log(
        "  --gateway-port <port>     Use an explicit host port for accessing the assistant.",
      );
      console.log(
        "  --assistant-ca-cert <path>  Trust an extra PEM CA bundle in the assistant container from process start.",
      );
      process.exit(0);
    } else if (arg === "-v" || arg == "--verbose") {
      verbose = true;
    } else if (arg === "--watch") {
      watch = true;
    } else if (arg === "--source") {
      const next = args[i + 1];
      if (!next || next.startsWith("-")) {
        console.error("Error: --source requires a path argument");
        process.exit(1);
      }
      sourcePath = next;
      i++;
    } else if (arg === "--name") {
      const next = args[i + 1];
      if (!next || next.startsWith("-")) {
        console.error("Error: --name requires a value");
        process.exit(1);
      }
      try {
        validateAssistantName(next);
      } catch {
        console.error(
          `Error: --name contains invalid characters (path separators or traversal segments are not allowed)`,
        );
        process.exit(1);
      }
      name = next;
      i++;
    } else if (arg === "--remote") {
      const next = args[i + 1];
      if (!next || !VALID_REMOTE_HOSTS.includes(next as RemoteHost)) {
        console.error(
          `Error: --remote requires one of: ${VALID_REMOTE_HOSTS.join(", ")}`,
        );
        process.exit(1);
      }
      remote = next as RemoteHost;
      i++;
    } else if (arg === "--config") {
      const next = args[i + 1];
      if (!next || next.startsWith("-")) {
        console.error("Error: --config requires a key=value argument");
        process.exit(1);
      }
      const eqIndex = next.indexOf("=");
      if (eqIndex <= 0) {
        console.error(
          `Error: --config value must be in key=value format, got '${next}'`,
        );
        process.exit(1);
      }
      const key = next.slice(0, eqIndex);
      const value = next.slice(eqIndex + 1);
      configValues[key] = value;
      i++;
    } else if (arg === "--netns-container") {
      const next = args[i + 1];
      if (!next || next.startsWith("-")) {
        console.error("Error: --netns-container requires a container name");
        process.exit(1);
      }
      netnsContainer = next;
      i++;
    } else if (arg === "--gateway-port") {
      const next = args[i + 1];
      const parsed = next ? Number(next) : NaN;
      if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
        console.error(
          "Error: --gateway-port requires an integer port in 1-65535",
        );
        process.exit(1);
      }
      gatewayPort = parsed;
      i++;
    } else if (arg === "--assistant-ca-cert") {
      const next = args[i + 1];
      if (!next || next.startsWith("-")) {
        console.error("Error: --assistant-ca-cert requires a path argument");
        process.exit(1);
      }
      assistantCaCert = next;
      i++;
    } else {
      console.error(
        `Error: Unknown argument '${arg}'. Valid options: -v, --verbose, --watch, --source <path>, --name <name>, --remote <${VALID_REMOTE_HOSTS.join("|")}>, --config <key=value>, --netns-container <name>, --gateway-port <port>, --assistant-ca-cert <path>`,
      );
      process.exit(1);
    }
  }

  return {
    verbose,
    name,
    remote,
    watch,
    sourcePath,
    configValues,
    netnsContainer,
    gatewayPort,
    assistantCaCert,
  };
}

function getCliVersion(): string {
  return cliPkg.version ?? "unknown";
}

export const hatch = Object.assign(
  async function hatch(): Promise<void> {
    const cliVersion = getCliVersion();
    console.log(`@mycadet/cli v${cliVersion}`);

    const {
      verbose,
      name,
      remote,
      watch,
      sourcePath,
      configValues,
      netnsContainer,
      gatewayPort,
      assistantCaCert,
    } = parseArgs();

    if (watch && remote !== "local" && remote !== "docker") {
      console.error(
        "Error: --watch is only supported for local and docker hatch targets.",
      );
      process.exit(1);
    }

    if (sourcePath !== null && remote !== "docker") {
      console.error(
        "Error: --source is only supported for docker hatch targets.",
      );
      process.exit(1);
    }

    if (
      (netnsContainer !== null ||
        gatewayPort !== null ||
        assistantCaCert !== null) &&
      remote !== "docker"
    ) {
      console.error(
        "Error: --netns-container, --gateway-port, and --assistant-ca-cert are only supported for docker hatch targets.",
      );
      process.exit(1);
    }

    if (netnsContainer !== null && gatewayPort === null) {
      console.error(
        "Error: --gateway-port is required with --netns-container (the namespace owner publishes the port before hatch runs).",
      );
      process.exit(1);
    }

    // The provider choice is remote-agnostic setup: every hatch wants the
    // LLM credentials settled before the assistant starts. Collected right
    // after the key check so the two prompts sit back-to-back.
    let provider = resolveHatchProvider(configValues);
    let precollectedApiKey: string | undefined;
    const apiKeyCheck = checkProviderApiKey();
    let pickedProvider = false;
    if (
      shouldPromptForHatchProvider({
        configValues,
        setupProviderCredentials: true,
        hasProviderApiKey: apiKeyCheck.hasKey,
        stdinIsTTY: process.stdin.isTTY,
      })
    ) {
      const picked = await promptProviderChoice();
      if (picked) {
        provider = picked;
        pickedProvider = true;
        // Collect the key immediately, while the choice is fresh.
        precollectedApiKey = await collectProviderApiKey(picked);

        // Picking Cadet Cloud should feel like signing in, not like a
        // mystery later — open the browser login right here.
        if (picked === "cadet" && process.stdin.isTTY && !readCloudToken()) {
          console.log("");
          console.log(
            "Cadet Cloud selected — opening your browser to log in...",
          );
          try {
            await ensureCloudLoginInteractive();
            console.log("✅ Logged in to Cadet Cloud");
          } catch (error) {
            console.warn(
              `⚠️  Cadet Cloud login failed: ${describeLoginError(error)}`,
            );
            console.warn("   You can retry later with `cadet login`.");
          }
        }
      }
    }

    if (!apiKeyCheck.hasKey && !pickedProvider) {
      console.warn(
        "Warning: No LLM provider API key is configured. The assistant will fail when you try to send a message.",
      );
      console.warn("  To fix, export your key before running cadet hatch:");
      console.warn("  export ANTHROPIC_API_KEY=<your-key>");
      console.warn("");
    }

    // The hatch operation is the package's provision door — every remote
    // goes through this one call. The art banner here and the hatched
    // summary below are the CLI's remote-agnostic narration, printed once
    // around the op whatever the remote is.
    console.log("");
    for (const line of HATCH_ART) {
      console.log(`   ${line}`);
    }
    console.log("");
    console.log("   Hatching assistant...");
    console.log("");

    const result = await hatchAssistant({
      remote,
      name,
      watch,
      configValues,
      verbose,
      version: cliVersion,
      sourcePath,
      netnsContainer: netnsContainer ?? undefined,
      gatewayPort: gatewayPort ?? undefined,
      assistantCaCertPath: assistantCaCert ?? undefined,
      provider,
      precollectedApiKey,
      log: (msg) => console.log(msg),
    });
    if (!result.ok) {
      if (result.status === 401) {
        console.error(result.error);
        process.exit(1);
      }
      throw new Error(result.error);
    }

    const entry = result.assistant;
    console.log(
      "   " +
        green(
          `${HATCHED_EMOJI}  Your assistant has hatched!`,
          process.stdout,
        ),
    );
    console.log("");
    printInstanceDetails(
      {
        name: entry.name,
        id: entry.assistantId,
        cloud: entry.cloud,
        runtime: entry.cloud === "cloud" ? undefined : getGatewayUrl(entry),
        root: "instanceDir" in entry ? entry.instanceDir : undefined,
        container:
          entry.cloud === "docker"
            ? dockerResourceNames(entry.assistantId).assistantContainer
            : undefined,
        status: result.status,
      },
      console.log,
    );
    console.log("");
    if (result.ready) {
      logHatchNextSteps(console.log);
    }
  },
  { description: "Create a new assistant instance" },
);
