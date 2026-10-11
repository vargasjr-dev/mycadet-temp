/**
 * `cadet terminal` — Interactive shell into an assistant.
 *
 * Dispatches by cloud type: a cloud terminal session (K8s exec) for
 * cloud assistants, `docker exec` for docker assistants, `gcloud compute
 * ssh` for GCP, raw ssh for custom hosts, and the container management
 * socket for apple-container assistants.
 *
 * Subcommands:
 *   cadet terminal                     — Interactive shell
 *   cadet terminal attach <name>       — Attach to a tmux session
 *   cadet terminal list                — List tmux sessions
 */

import { isCloudHome } from "../lib/cloud-values.js";
import { spawn } from "child_process";

import { extractHostFromUrl, resolveAssistant } from "../lib/assistant-config";
import { dockerResourceNames } from "../lib/docker";
import { getCloudUrl, readCloudToken } from "../lib/cloud-client";
import { sshAppleContainer } from "../lib/ssh-apple-container";
import {
  closeTerminalSession,
  createTerminalSession,
  sendTerminalInput,
  subscribeTerminalEvents,
} from "../lib/terminal-client.js";
import {
  interactiveSession,
  resolveManagedAssistant,
} from "../lib/terminal-session.js";
import type { ResolvedManagedAssistant } from "../lib/terminal-session.js";
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
  console.log("Usage: cadet terminal [subcommand] [options]");
  console.log("");
  console.log("Open an interactive terminal session into an assistant.");
  console.log("");
  console.log(
    "Managed (cloud-hosted) assistants get a cloud terminal session; docker",
  );
  console.log(
    "assistants shell in via docker exec, GCP assistants via gcloud, custom",
  );
  console.log("hosts via ssh, and apple-container assistants via their management socket.");
  console.log("");
  console.log("Subcommands:");
  console.log("  (none)              Interactive shell");
  console.log(
    "  attach <name>       Attach to a tmux session inside the container",
  );
  console.log(
    "  list                List tmux sessions running inside the container",
  );
  console.log("");
  console.log("Options:");
  console.log(
    "  <name>              Name of the assistant (defaults to active)",
  );
  console.log(
    "  --assistant <name>  Explicit assistant name (alternative to positional)",
  );
  console.log("");
  console.log("Examples:");
  console.log("  cadet terminal");
  console.log("  cadet terminal attach my-session");
  console.log("  cadet terminal list");
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
// List tmux sessions
// ---------------------------------------------------------------------------

async function listTmuxSessions(
  assistant: ResolvedManagedAssistant,
): Promise<void> {
  const cols = 120;
  const rows = 24;

  const { session_id: sessionId } = await createTerminalSession(
    assistant.token,
    assistant.assistantId,
    cols,
    rows,
    assistant.cloudUrl,
  );

  const abortController = new AbortController();
  const output: string[] = [];
  let commandSent = false;

  try {
    const timeout = setTimeout(() => abortController.abort(), 5000);

    const streamPromise = (async () => {
      for await (const event of subscribeTerminalEvents(
        assistant.token,
        assistant.assistantId,
        sessionId,
        assistant.cloudUrl,
        abortController.signal,
      )) {
        const text = Buffer.from(event.data, "base64").toString("utf-8");
        output.push(text);

        // Wait for shell prompt before sending command
        if (!commandSent) {
          const joined = output.join("");
          if (
            joined.includes("$") ||
            joined.includes("#") ||
            joined.includes("%")
          ) {
            commandSent = true;
            await sendTerminalInput(
              assistant.token,
              assistant.assistantId,
              sessionId,
              'tmux list-sessions 2>/dev/null || echo "No tmux sessions found"; exit\r',
              assistant.cloudUrl,
            );
          }
        }
      }
    })();

    await streamPromise.catch(() => {});
    clearTimeout(timeout);
  } catch {
    // Expected — abort or stream end
  } finally {
    abortController.abort();
    await closeTerminalSession(
      assistant.token,
      assistant.assistantId,
      sessionId,
      assistant.cloudUrl,
    ).catch(() => {});
  }

  // Parse and display results
  const raw = output.join("");
  // Strip ANSI escape sequences for clean parsing
  const clean = raw.replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: needed for ANSI stripping
    /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][^\n]|\r/g,
    "",
  );

  // Find tmux output lines (format: "session_name: N windows ...")
  const lines = clean.split("\n");
  const sessionLines = lines.filter(
    (l) =>
      /^\S+:\s+\d+\s+windows?/.test(l.trim()) ||
      l.includes("No tmux sessions found"),
  );

  if (sessionLines.length === 0) {
    console.log("No tmux sessions found.");
  } else {
    for (const line of sessionLines) {
      console.log(line.trim());
    }
  }
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
  //   cadet terminal [--assistant <name>]
  //   cadet terminal list [--assistant <name>]
  //   cadet terminal attach <session> [--assistant <name>]
  let subcommand: string | undefined;
  let assistantName: string | undefined;
  let tmuxSessionName: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--assistant" && args[i + 1]) {
      assistantName = args[++i];
    } else if (args[i].startsWith("-")) {
      // Skip unknown flags
      continue;
    } else if (!subcommand) {
      // First positional — subcommand or assistant name
      if (args[i] === "list" || args[i] === "attach") {
        subcommand = args[i];
      } else {
        assistantName = args[i];
      }
    } else if (subcommand === "attach" && !tmuxSessionName) {
      // Second positional after "attach" — tmux session name
      tmuxSessionName = args[i];
    } else if (!assistantName) {
      // Trailing positional after subcommand args — assistant name
      assistantName = args[i];
    }
  }

  // tmux subcommands are managed-cloud features
  if (subcommand === "list") {
    await listTmuxSessions(resolveManagedAssistant(assistantName));
    return;
  }

  if (subcommand === "attach") {
    if (!tmuxSessionName) {
      console.error("Usage: cadet terminal attach <session-name>");
      console.error(
        "\nUse 'cadet terminal list' to see available tmux sessions.",
      );
      process.exit(1);
    }
    // Shell-escape the session name to handle spaces/metacharacters
    const escaped = tmuxSessionName.replace(/'/g, "'\\''");
    await interactiveSession(
      resolveManagedAssistant(assistantName),
      `tmux attach -t '${escaped}'`,
    );
    return;
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
    const token = readCloudToken();
    if (!token) {
      console.error(
        "Not logged in. Run `cadet login` first to authenticate with Cadet Cloud.",
      );
      process.exit(1);
    }
    await interactiveSession({
      assistantId: entry.assistantId,
      token,
      cloudUrl: getCloudUrl(),
    });
    return;
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
