import { isCloudHome } from "../lib/cloud-values.js";
import { getGatewayUrl } from "@mycadet/local-mode/contract";
import { cliCommand } from "../lib/cli-name.js";
import { existsSync, unlinkSync } from "fs";
import { join } from "path";

import { type LockfileAssistant } from "@mycadet/local-mode/contract";
import {
  extractHostFromEntry,
  formatAssistantLookupError,
  getActiveAssistant,
  getAssistantDisplayName,
  loadAllAssistants,
  lookupAssistantByIdentifier,
  removeLockfileAssistant,
} from "../lib/assistant-config.js";
import { parseAssistantTargetArg } from "../lib/assistant-target-args.js";
import {
  canPromptForConfirmation,
  confirmAction,
} from "../lib/confirm-action.js";
import { resolveConfigDir } from "@mycadet/local-mode";
import { printInstanceDetails } from "../lib/instance-details.js";
import {
  authHeaders,
  authHeadersForKnownOrganization,
  getCloudUrl,
  readCloudToken,
} from "../lib/cloud-client.js";
import { retireDocker, dockerResourceNames } from "../lib/remotes/docker.js";
import { stopContainerAppServer } from "../lib/servers/nginx.js";
import { retireLocal } from "../lib/retire-local.js";
import { retireAppleContainer } from "../lib/retire-apple-container.js";
import { exec } from "../lib/step-runner.js";
import { loopbackSafeFetch } from "../lib/loopback-fetch.js";

interface RetireArgs {
  name?: string;
  source?: string;
  yes: boolean;
}

const CLOUD_TOKEN_ENV = "CADET_CLOUD_TOKEN";
const LEGACY_CLOUD_TOKEN_ENV = "CADET_PLATFORM_TOKEN";

function readPlatformRetireToken(): string | null {
  const envToken = (
    process.env[CLOUD_TOKEN_ENV] ?? process.env[LEGACY_CLOUD_TOKEN_ENV]
  )?.trim();
  if (envToken) return envToken;
  return readCloudToken();
}

function nonEmptyString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

async function deleteCloudAssistant(
  assistantId: string,
  options: {
    token: string;
    cloudUrl?: string;
    organizationId?: string;
    label: string;
    successMessage: string;
    alreadyGoneMessage: string;
  },
): Promise<void> {
  const cloudUrl = options.cloudUrl || getCloudUrl();
  const url = `${cloudUrl}/v1/assistants/${encodeURIComponent(assistantId)}/retire/`;
  const headers = options.organizationId
    ? authHeadersForKnownOrganization(options.token, options.organizationId)
    : await authHeaders(options.token, cloudUrl);

  const response = await loopbackSafeFetch(url, {
    method: "DELETE",
    headers,
  });

  if (!response.ok && response.status !== 404) {
    const body = await response.text();
    throw new Error(`${options.label} failed (${response.status}): ${body}`);
  }

  if (response.status === 404) {
    console.log(options.alreadyGoneMessage);
  } else {
    console.log(options.successMessage);
  }
}

async function unregisterSelfHostedLocalPlatformRecord(
  entry: LockfileAssistant,
): Promise<void> {
  const token = readPlatformRetireToken();
  if (!token) return;

  const cloudAssistantId =
    entry.cloud === "custom" || entry.cloud === "baseten"
      ? undefined
      : nonEmptyString(entry.cloudAssistantId);
  if (!cloudAssistantId) return;

  await deleteCloudAssistant(cloudAssistantId, {
    token,
    cloudUrl: getCloudUrl(),
    organizationId:
      entry.cloud === "custom" || entry.cloud === "baseten"
        ? undefined
        : (nonEmptyString(entry.cloudOrganizationId) ?? undefined),
    label: "Platform self-hosted unregister",
    successMessage: "✅ Platform self-hosted registration unregistered.",
    alreadyGoneMessage:
      "✅ Platform self-hosted registration already unregistered (404).",
  });
}

async function retireCustom(entry: LockfileAssistant): Promise<void> {
  const host = extractHostFromEntry(entry);
  const sshHost = `root@${host}`;

  console.log(`\u{1F5D1}\ufe0f  Retiring custom instance on ${sshHost}...\n`);

  const remoteCmd = [
    "bunx cadet sleep 2>/dev/null || true",
    "pkill -f gateway 2>/dev/null || true",
    "rm -rf ~/.cadet",
  ].join(" && ");

  try {
    await exec("ssh", [
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "UserKnownHostsFile=/dev/null",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "LogLevel=ERROR",
      sshHost,
      remoteCmd,
    ]);
  } catch (error) {
    console.warn(
      `\u26a0\ufe0f  Remote cleanup may have partially failed: ${error instanceof Error ? error.message : error}`,
    );
  }

  console.log(`\u2705 Custom instance retired.`);
}

async function retireCloud(entry: LockfileAssistant): Promise<void> {
  console.log("\u{1F5D1}\ufe0f  Retiring Cadet Cloud-hosted instance...\n");

  const token = readPlatformRetireToken();
  if (!token) {
    console.error(
      "Error: Not logged in. Run `cadet login --token <token>` first.",
    );
    process.exit(1);
  }

  try {
    await deleteCloudAssistant(entry.assistantId, {
      token,
      cloudUrl: getGatewayUrl(entry),
      label: "Platform retire",
      successMessage: "\u2705 Platform-hosted instance retired.",
      alreadyGoneMessage:
        "\u2705 Platform-hosted instance already retired (404) \u2014 cleaning up local state.",
    });
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

function parseRetireArgs(args: string[]): RetireArgs {
  let source: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--source" && args[i + 1]) {
      source = args[i + 1];
      i++;
    }
  }

  return {
    name: parseAssistantTargetArg(args, ["--source"]),
    source,
    yes: args.includes("--yes"),
  };
}

function printRetireTarget(entry: LockfileAssistant): void {
  console.log("Assistant to retire:");
  printInstanceDetails(
    {
      name: getAssistantDisplayName(entry),
      id: entry.assistantId,
      cloud: entry.cloud,
      runtime: getGatewayUrl(entry),
      ...(entry.cloud === "local" && entry.instanceDir
        ? { root: entry.instanceDir }
        : {}),
      ...(entry.cloud === "docker"
        ? {
            container: dockerResourceNames(entry.assistantId)
              .assistantContainer,
          }
        : {}),
    },
    console.log,
  );
  console.log("");
}

export const retire = Object.assign(
  async function retire(): Promise<void> {
    await retireInner();
  },
  { description: "Delete an assistant instance" },
);

async function retireInner(): Promise<void> {
  const args = process.argv.slice(3);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      `Usage: ${cliCommand()} retire [<name-or-id>] [--source <source>] [--yes]`,
    );
    console.log("");
    console.log("Delete an assistant instance and archive its data.");
    console.log(
      "With no name or ID, retires the active assistant — see `cadet use`. By default, retire prints the assistant name, ID, cloud, and runtime before asking for confirmation.",
    );
    console.log("");
    console.log("Arguments:");
    console.log(
      "  <name-or-id>         Assistant display name or ID to retire, defaults to the active assistant",
    );
    console.log("");
    console.log("Options:");
    console.log("  --source <source>    Source identifier for the retirement");
    console.log(
      "  --yes                Skip the interactive confirmation prompt",
    );
    process.exit(0);
  }

  const parsed = parseRetireArgs(args);
  // No name given: retire whichever assistant is currently in use.
  const name = parsed.name ?? getActiveAssistant() ?? undefined;

  if (!name) {
    console.error(
      "Error: No assistant specified and no active assistant. Pass a name or ID, or pick one with `cadet use <name>`.",
    );
    console.error(
      `Usage: ${cliCommand()} retire <name-or-id> [--source <source>] [--yes]`,
    );
    process.exit(1);
  }

  const lookup = lookupAssistantByIdentifier(name);
  if (lookup.status !== "found") {
    console.error(formatAssistantLookupError(name, lookup));
    console.error(
      `Run '${cliCommand()} hatch' first, or check the instance name.`,
    );
    process.exit(1);
  }

  const entry = lookup.entry;
  const assistantId = entry.assistantId;
  const cloud = entry.cloud;

  printRetireTarget(entry);

  if (!parsed.yes) {
    if (!canPromptForConfirmation()) {
      console.error(
        "Error: Refusing to retire without confirmation in a non-interactive terminal.",
      );
      console.error("Re-run with --yes to confirm from automation.");
      process.exit(1);
    }

    const confirmed = await confirmAction(
      "Press Enter to retire, or Esc/q to cancel: ",
    );
    if (!confirmed) {
      console.log("Retire cancelled.");
      process.exit(1);
    }
  }

  if (cloud === "apple-container") {
    await retireAppleContainer(assistantId, entry);
    await stopContainerAppServer(entry);
  } else if (cloud === "docker") {
    await retireDocker(assistantId);
    await stopContainerAppServer(entry);
  } else if (cloud === "local") {
    try {
      await unregisterSelfHostedLocalPlatformRecord(entry);
    } catch (error) {
      console.warn(
        `⚠️  Platform self-hosted unregister failed; continuing local retire: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    await retireLocal(assistantId, entry);
  } else if (cloud === "custom") {
    await retireCustom(entry);
  } else if (isCloudHome(cloud)) {
    await retireCloud(entry);
  } else {
    console.error(`Error: Unknown remote type '${cloud}'.`);
    process.exit(1);
  }

  removeLockfileAssistant(assistantId);
  console.log(`Removed ${getAssistantDisplayName(entry)} from config.`);

  // When no assistants remain, remove the dock-display-name sentinel so
  // the dock label falls back to "Cadet" instead of using the
  // retired assistant's name.
  if (loadAllAssistants().length === 0) {
    const dockLabelFile = join(resolveConfigDir(), "dock-display-name");
    if (existsSync(dockLabelFile)) {
      try {
        unlinkSync(dockLabelFile);
      } catch {
        // Best-effort — the macOS app will also reset this on next launch.
      }
    }
  }
}
