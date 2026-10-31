import { createConnection } from "node:net";
import { existsSync } from "node:fs";

import { isAppleContainerEntry } from "../../lockfile-contract";
import type { LockfileAssistant } from "../../lockfile-contract";

/**
 * The apple-container topology's retire leg: send a retire command to the
 * macOS app via the management socket. The app handles the full lifecycle:
 * stop the pod, archive the instance directory, remove the guardian token,
 * deregister from the cloud, and remove the lockfile entry.
 *
 * Headless contract: guard failures THROW (the route maps them to the wire;
 * the CLI surfaces them as its exit-1 error) — this module never exits the
 * process it runs in.
 */

export async function retireAppleContainer(
  name: string,
  entry: LockfileAssistant,
): Promise<void> {
  console.log(
    `\u{1F5D1}\ufe0f  Retiring Apple Container assistant '${name}'...\n`,
  );

  if (!isAppleContainerEntry(entry)) {
    throw new Error(
      `'${entry.assistantId}' is not an apple-container assistant.`,
    );
  }
  const mgmtSocket = entry.mgmtSocket;
  if (!mgmtSocket) {
    throw new Error(
      `No management socket found for '${name}'.\n` +
        "The assistant may not be running. If the macOS app is closed, " +
        "open it and try again.",
    );
  }

  if (!existsSync(mgmtSocket)) {
    throw new Error(
      `Management socket not found at ${mgmtSocket}.\n` +
        "The assistant may have been stopped. Open the macOS app and try again.",
    );
  }

  const handshake = JSON.stringify({ action: "retire" }) + "\n";

  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ path: mgmtSocket }, () => {
      socket.write(handshake);
    });

    const TIMEOUT_MS = 30_000;
    const chunks: Buffer[] = [];
    let totalLen = 0;

    socket.setTimeout(TIMEOUT_MS);
    socket.on("timeout", () => {
      socket.destroy();
      reject(
        new Error("Timed out waiting for retire response from the macOS app."),
      );
    });

    socket.on("data", (data: Buffer) => {
      chunks.push(data);
      totalLen += data.length;
      const accumulated = Buffer.concat(chunks, totalLen);
      const nlIndex = accumulated.indexOf(0x0a);
      if (nlIndex === -1) return;

      const responseLine = accumulated.slice(0, nlIndex).toString("utf-8");
      socket.destroy();

      let response: { status: string; message?: string };
      try {
        response = JSON.parse(responseLine) as {
          status: string;
          message?: string;
        };
      } catch {
        reject(new Error("Invalid response from management socket."));
        return;
      }

      if (response.status === "ok") {
        console.log(`\u2705 Apple Container assistant '${name}' retired.`);
        resolve();
      } else {
        reject(
          new Error(`Retire failed: ${response.message || "unknown error"}`),
        );
      }
    });

    socket.on("error", (err) => {
      reject(new Error(`Management socket error: ${err.message}`));
    });

    socket.on("end", () => {
      if (chunks.length === 0) {
        reject(
          new Error(
            "Management socket closed without responding. " +
              "The macOS app may have crashed during retire.",
          ),
        );
      }
    });
  });
}
