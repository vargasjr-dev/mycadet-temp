/**
 * The apple-container remote's CLI surface: exec, ssh, and the pairing mint
 * through the assistant's management socket. One file — the remote's whole
 * CLI presence, matching the baseten/docker/local module layout.
 */
import { createConnection } from "net";
import { existsSync } from "fs";

import {
  isAppleContainerEntry,
  type LockfileAssistant,
} from "@mycadet/local-mode/contract";

/**
 * Execute a command inside an Apple Container assistant via the management
 * socket. Non-interactive: sends the command, streams stdout/stderr to the
 * terminal, and exits with the appropriate code.
 */
export async function execAppleContainer(
  entry: LockfileAssistant,
  command: string[],
  service: string,
): Promise<void> {
  return runAppleContainerExec(entry, command, service, (data) =>
    process.stdout.write(data),
  );
}

/**
 * Mint (and approve) a remote-web pairing challenge inside the assistant's
 * gateway service — the apple-container topology's `gateway pairing mint`,
 * run through the management socket's exec with the output CAPTURED (the
 * caller needs the challenge JSON, not a terminal stream). Returns the
 * command's stdout; its last line is the challenge JSON.
 */
export async function appleContainerPair(
  entry: LockfileAssistant,
): Promise<string> {
  const chunks: Buffer[] = [];
  await runAppleContainerExec(
    entry,
    ["bun", "run", "src/cli/index.ts", "pairing", "mint"],
    "cadet-gateway",
    (data) => chunks.push(data),
  );
  return Buffer.concat(chunks).toString("utf-8");
}

async function runAppleContainerExec(
  entry: LockfileAssistant,
  command: string[],
  service: string,
  onOutput: (data: Buffer) => void,
): Promise<void> {
  if (!isAppleContainerEntry(entry)) {
    console.error(
      `'${entry.assistantId}' is not an apple-container assistant.`,
    );
    process.exit(1);
  }
  const mgmtSocket = entry.mgmtSocket;
  if (!mgmtSocket) {
    console.error(
      `No management socket found for '${entry.assistantId}'.\n` +
        "The assistant may not be running.",
    );
    process.exit(1);
  }

  if (!existsSync(mgmtSocket)) {
    console.error(
      `Management socket not found at ${mgmtSocket}.\n` +
        "The assistant may have been stopped.",
    );
    process.exit(1);
  }

  const handshake =
    JSON.stringify({
      command,
      service,
      cols: process.stdout.columns || 120,
      rows: process.stdout.rows || 40,
    }) + "\n";

  return new Promise<void>((resolve, reject) => {
    const socket = createConnection({ path: mgmtSocket }, () => {
      socket.write(handshake);
    });

    const HANDSHAKE_TIMEOUT_MS = 10_000;
    let handshakeComplete = false;
    const handshakeChunks: Buffer[] = [];
    let handshakeLen = 0;

    socket.setTimeout(HANDSHAKE_TIMEOUT_MS);
    socket.on("timeout", () => {
      if (!handshakeComplete) {
        console.error("Timed out waiting for response from management socket.");
        socket.destroy();
        process.exit(1);
      }
    });

    socket.on("data", (data: Buffer) => {
      if (!handshakeComplete) {
        handshakeChunks.push(data);
        handshakeLen += data.length;
        const accumulated = Buffer.concat(handshakeChunks, handshakeLen);
        const nlIndex = accumulated.indexOf(0x0a);
        if (nlIndex === -1) return;

        const responseLine = accumulated.slice(0, nlIndex).toString("utf-8");
        const remainder = accumulated.slice(nlIndex + 1);
        handshakeComplete = true;
        socket.setTimeout(0);

        let response: { status: string; message?: string };
        try {
          response = JSON.parse(responseLine) as {
            status: string;
            message?: string;
          };
        } catch {
          console.error("Invalid response from management socket.");
          socket.destroy();
          process.exit(1);
          return;
        }

        if (response.status !== "ok") {
          console.error(`Exec failed: ${response.message || "unknown error"}`);
          socket.destroy();
          process.exit(1);
          return;
        }

        // Write any bytes that arrived after the handshake newline.
        if (remainder.length > 0) {
          onOutput(remainder);
        }
        return;
      }

      // Stream command output to the sink.
      onOutput(data);
    });

    socket.on("end", () => {
      if (handshakeComplete) {
        resolve();
      } else {
        reject(new Error("Connection closed before handshake completed."));
      }
    });

    socket.on("error", (err) => {
      reject(new Error(`Management socket error: ${err.message}`));
    });

    socket.on("close", () => {
      if (handshakeComplete) {
        resolve();
      }
    });
  });
}

/**
 * Connect to an Apple Container assistant via its management socket.
 * Sends a JSON handshake then relays stdin/stdout in raw mode.
 */
export async function sshAppleContainer(
  entry: LockfileAssistant,
  command?: string[],
  service?: string,
): Promise<void> {
  if (!isAppleContainerEntry(entry)) {
    console.error(
      `'${entry.assistantId}' is not an apple-container assistant.`,
    );
    process.exit(1);
  }
  const mgmtSocket = entry.mgmtSocket;
  if (!mgmtSocket) {
    console.error(
      `No management socket found for '${entry.assistantId}'.\n` +
        "The assistant may not have finished starting. Try again in a moment.",
    );
    process.exit(1);
  }

  if (!existsSync(mgmtSocket)) {
    console.error(
      `Management socket not found at ${mgmtSocket}.\n` +
        "The assistant may have been stopped. Run 'cadet hatch' to start it.",
    );
    process.exit(1);
  }

  console.log(
    `🔗 Connecting to ${entry.assistantId} via apple container exec...\n`,
  );

  const cols = process.stdout.columns || 120;
  const rows = process.stdout.rows || 40;

  const handshake =
    JSON.stringify({
      command: command && command.length > 0 ? command : ["/bin/bash"],
      service: service || "mycadet",
      cols,
      rows,
    }) + "\n";

  return new Promise<void>((resolve, reject) => {
    const socket = createConnection({ path: mgmtSocket }, () => {
      // Send handshake as soon as connected.
      socket.write(handshake);
    });

    // 10s handshake timeout — matches SSH ConnectTimeout.
    const HANDSHAKE_TIMEOUT_MS = 10_000;
    let handshakeComplete = false;
    const handshakeChunks: Buffer[] = [];
    let handshakeLen = 0;

    socket.setTimeout(HANDSHAKE_TIMEOUT_MS);
    socket.on("timeout", () => {
      if (!handshakeComplete) {
        console.error(
          "Timed out waiting for handshake response from management socket.",
        );
        socket.destroy();
        process.exit(1);
      }
      // After handshake, no timeout — interactive session runs indefinitely.
    });

    socket.on("data", (data: Buffer) => {
      if (!handshakeComplete) {
        // Accumulate raw buffers until we find a newline (end of JSON response).
        handshakeChunks.push(data);
        handshakeLen += data.length;
        const accumulated = Buffer.concat(handshakeChunks, handshakeLen);
        const nlIndex = accumulated.indexOf(0x0a);
        if (nlIndex === -1) return; // Wait for more data.

        const responseLine = accumulated.slice(0, nlIndex).toString("utf-8");
        const remainder = accumulated.slice(nlIndex + 1);
        handshakeComplete = true;
        socket.setTimeout(0); // Disable timeout for interactive session.

        let response: { status: string; message?: string };
        try {
          response = JSON.parse(responseLine) as {
            status: string;
            message?: string;
          };
        } catch {
          console.error("Invalid handshake response from management socket.");
          socket.destroy();
          process.exit(1);
          return;
        }

        if (response.status !== "ok") {
          console.error(`Exec failed: ${response.message || "unknown error"}`);
          socket.destroy();
          process.exit(1);
          return;
        }

        // Handshake succeeded — enter raw mode and relay stdio.
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(true);
        }
        process.stdin.resume();
        process.stdin.pipe(socket);

        // Write any raw bytes that arrived after the handshake newline.
        if (remainder.length > 0) {
          process.stdout.write(remainder);
        }

        // From now on, relay socket data to stdout.
        return;
      }

      // Raw mode: relay container output to stdout.
      process.stdout.write(data);
    });

    socket.on("end", () => {
      cleanup();
      if (handshakeComplete) {
        resolve();
      } else {
        reject(
          new Error(
            "Management socket closed before handshake completed. " +
              "The assistant may be restarting.",
          ),
        );
      }
    });

    socket.on("error", (err) => {
      cleanup();
      reject(new Error(`Management socket error: ${err.message}`));
    });

    socket.on("close", () => {
      cleanup();
      if (handshakeComplete) {
        resolve();
      } else {
        reject(
          new Error(
            "Management socket closed before handshake completed. " +
              "The assistant may be restarting.",
          ),
        );
      }
    });

    function cleanup(): void {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.unpipe(socket);
      process.stdin.pause();
    }
  });
}
