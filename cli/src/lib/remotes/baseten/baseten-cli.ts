/**
 * The installed `baseten` CLI arm of the remote's fallback: when the CLI is
 * on PATH it is preferred for push/create — it streams build logs and owns
 * its own auth, so no Baseten env credentials are needed.
 */

import { spawn } from "node:child_process";
import { execOutput } from "../../step-runner.js";

/** The installed baseten CLI, or null when it isn't on PATH. Exported for tests. */
export async function resolveBasetenCli(): Promise<string | null> {
  try {
    await execOutput("baseten", ["--version"]);
    return "baseten";
  } catch {
    return null;
  }
}

/** Run the baseten CLI with inherited stdio so its logs stream to the caller. */
export function runBasetenCli(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("baseten", args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`baseten ${args.join(" ")} exited with ${code}`));
      }
    });
  });
}

/**
 * Run the baseten CLI and capture stdout — for read-only queries whose
 * output the caller parses (e.g. a sandbox's URL off `describe --jq`).
 */
export async function captureBasetenCli(args: string[]): Promise<string> {
  return (await execOutput("baseten", args)).trim();
}
