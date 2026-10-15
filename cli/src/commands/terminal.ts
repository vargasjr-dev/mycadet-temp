/**
 * `cadet terminal` — Interactive shell into an assistant.
 *
 * Dispatches by cloud type: `docker exec` for docker assistants,
 * `gcloud compute ssh` for GCP, raw ssh for custom hosts, and the container
 * management socket for apple-container assistants.
 *
 * Usage: cadet terminal [<name>]
 */

import { spawn } from "child_process";

import { extractHostFromUrl, resolveAssistant } from "../lib/assistant-config";
import { isCloudHome } from "../lib/cloud-values.js";
import { dockerResourceNames } from "../lib/docker";
import { sshAppleContainer } from "../lib/ssh-apple-container";
import type { ChildProcess } from "child_process";

const SSH_OPTS = [
  "-o",
  "StrictHostKeyChecking=no",
  "-o",
  "UserKnownHostsFile=/dev/null",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "LogLevel=ERROR",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function printHelp(): void {
  console.log("Usage: cadet terminal [options]");
  console.log("");
  console.log("Open an interactive terminal session into an assistant.");
  console.log("");
  console.log(
    "Docker assistants shell in via docker exec, GCP assistants via gcloud,",
  );
  console.log("custom hosts via ssh, and apple-container assistants via their management socket.");
  console.log("");
  console.log("Options:");
  console.log(
    "  <name>              Name of the assistant, defaults to active",
  );
  console.log(
    "  --assistant <name>  Explicit assistant name (alternative to positional)",
  );
  console.log("");
  console.log("Examples:");
  console.log("  cadet terminal");
  console.log("  cadet terminal --assistant my-assistant");
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`terminal exited with code ${code}`));
      }
    });
    child.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export const terminal = Object.assign(
  async function terminal(): Promise<void> {
  const args = process.argv.slice(3);

  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  // Parse arguments
  //
  // Accepted forms:
  //   cadet terminal
  //   cadet terminal [--assistant <name>]
  let assistantName: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--assistant" && args[i + 1]) {
      assistantName = args[++i];
    } else if (args[i].startsWith("-")) {
      // Skip unknown flags
      continue;
    } else if (!assistantName) {
      assistantName = args[i];
    }
  }

  // Default: interactive shell, dispatched by the assistant's cloud type.
  const entry = resolveAssistant(assistantName);

  if (!entry) {
    if (assistantName) {
      console.error(`No assistant instance found with name '${assistantName}'.`);
    } else {
      console.error("No assistant instance found. Run `cadet hatch` first.");
    }
    process.exit(1);
  }

  const cloud = entry.cloud;

  if (cloud === "local") {
    console.error(
      "Cannot open a terminal into a local assistant. Local assistants run directly on this machine.\n" +
        `Use 'cadet ps ${entry.assistantId}' to check its processes instead.`,
    );
    process.exit(1);
  }

  if (cloud === "aws") {
    console.error("Terminals on AWS instances are not yet supported.");
    process.exit(1);
  }

  // Apple container: connect to the management socket for an interactive shell.
  if (cloud === "apple-container") {
    await sshAppleContainer(entry);
    return;
  }

  if (cloud === "docker") {
    const res = dockerResourceNames(entry.assistantId);
    console.log(`🔗 Connecting to ${entry.assistantId} via docker exec...\n`);

    const child = spawn(
      "docker",
      ["exec", "-it", res.assistantContainer, "/bin/sh"],
      { stdio: "inherit", windowsHide: true },
    );
    await waitForExit(child);
    return;
  }

  if (cloud === "gcp") {
    const project = entry.project;
    const zone = entry.zone;
    if (!project || !zone) {
      console.error("Error: GCP project and zone not found in assistant config.");
      process.exit(1);
    }

    const sshTarget = entry.sshUser
      ? `${entry.sshUser}@${entry.assistantId}`
      : entry.assistantId;

    console.log(`🔗 Connecting to ${entry.assistantId} via gcloud...\n`);

    const child = spawn(
      "gcloud",
      ["compute", "ssh", sshTarget, `--project=${project}`, `--zone=${zone}`],
      { stdio: "inherit", windowsHide: true },
    );
    await waitForExit(child);
    return;
  }

  if (isCloudHome(cloud)) {
    console.error(
      "Terminals on managed cloud assistants are not supported.",
    );
    process.exit(1);
  }

  if (cloud === "custom") {
    const host = extractHostFromUrl(entry.runtimeUrl);
    const sshUser = entry.sshUser ?? "root";
    const sshTarget = `${sshUser}@${host}`;

    console.log(`🔗 Connecting to ${entry.assistantId} via ssh...\n`);

    const child = spawn("ssh", [...SSH_OPTS, sshTarget], {
      stdio: "inherit",
      windowsHide: true,
    });
    await waitForExit(child);
    return;
  }

  console.error(`Error: Unknown cloud type '${cloud}'.`);
  process.exit(1);
},
  { description: "Open a terminal into an assistant" },
);
