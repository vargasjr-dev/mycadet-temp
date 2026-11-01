// Direct import — bun embeds this at compile time so it works in compiled binaries.
import { isCloudHome } from "../lib/cloud-values.js";
import { cliCommand } from "../lib/cli-name.js";
import cliPkg from "../../package.json";

import { setActiveAssistant } from "../lib/assistant-config";
import { saveLockfileAssistant } from "@mycadet/local-mode";
import { green } from "../lib/color";
import { HATCH_ART, HATCHED_EMOJI, VALID_REMOTE_HOSTS } from "../lib/constants";
import type { RemoteHost } from "../lib/constants";
import { hatchDocker } from "../lib/remotes/docker.js";
import { hatchBaseten } from "../lib/remotes/baseten/index";
import { hatchLocal } from "../lib/remotes/local.js";
import { hatchAssistant, readCloudToken } from "../lib/cloud-client";
import { validateAssistantName } from "../lib/retire-archive";

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

    if (remote === "local") {
      await hatchLocal({
        name,
        watch,
        configValues,
        verbose,
      });
      return;
    }

    if (remote === "docker") {
      await hatchDocker({
        name,
        watch,
        configValues,
        sourcePath,
        netnsContainer: netnsContainer ?? undefined,
        gatewayPort: gatewayPort ?? undefined,
        assistantCaCertPath: assistantCaCert ?? undefined,
      });
      return;
    }

    if (remote === "baseten") {
      await hatchBaseten({
        name: name ?? undefined,
        configValues,
        verbose,
      });
      return;
    }

    if (isCloudHome(remote)) {
      await hatchCadetPlatform();
      return;
    }

    console.error(`Error: Remote host '${remote}' is not yet supported.`);
    process.exit(1);
  },
  { description: "Create a new assistant instance" },
);

async function hatchCadetPlatform(): Promise<void> {
  const token = readCloudToken();
  if (!token) {
    console.error("Not logged in. Run `cadet login --token <token>` first.");
    process.exit(1);
  }

  console.log("");
  for (const line of HATCH_ART) {
    console.log(`   ${line}`);
  }
  console.log("");
  console.log("   Hatching assistant on Cadet Cloud...");
  console.log("");

  const { assistant: result } = await hatchAssistant(token);

  saveLockfileAssistant({
    assistantId: result.id,
    cloud: "cloud",
    hatchedAt: new Date().toISOString(),
  });
  setActiveAssistant(result.id);

  console.log(
    "   " +
      green(`${HATCHED_EMOJI}  Your assistant has hatched!`, process.stdout),
  );
  console.log("");
  console.log(`   ID:     ${result.id}`);
  console.log(`   Name:   ${result.name}`);
  console.log(`   Status: ${result.status}`);
  console.log("");
}
