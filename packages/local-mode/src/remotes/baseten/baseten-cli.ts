/**
 * The installed `baseten` CLI arm of the remote's fallback: when the CLI is
 * on PATH it is preferred for push/create — it streams build logs and owns
 * its own auth, so no Baseten env credentials are needed.
 */

import { execOutput } from "../../exec.js";

/** The installed baseten CLI, or null when it isn't on PATH. Exported for tests. */
export async function resolveBasetenCli(): Promise<string | null> {
  try {
    await execOutput("baseten", ["--version"]);
    return "baseten";
  } catch {
    return null;
  }
}

/**
 * Run the baseten CLI with its output captured: the hatch narrates its own
 * progress (one "pushing" line, then the result), so the CLI's own banner
 * ("Pushed... Waiting for it to build...") and tables stay quiet on
 * success — and ride the error as the diagnostic when it fails.
 */
export async function runBasetenCliCaptured(args: string[]): Promise<string> {
  return (await execOutput("baseten", args)).trim();
}

/**
 * Run the baseten CLI and capture stdout — for read-only queries whose
 * output the caller parses (e.g. a sandbox's URL off `describe --jq`).
 */
export async function captureBasetenCli(args: string[]): Promise<string> {
  return (await execOutput("baseten", args)).trim();
}
