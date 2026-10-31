/**
 * The cloud-home remotes' (cloud, custom, baseten) CLI surface: one-shot
 * commands ride the platform's terminal-session exec API — the same seam
 * `cadet exec` drives for these topologies.
 */
import { getCloudUrl, readCloudToken } from "../cloud-client.js";
import { execViaTerminalSession } from "../terminal-session.js";
import type { LockfileAssistant } from "@mycadet/local-mode/contract";

/**
 * Mint (and approve) a remote-web pairing challenge on the assistant's
 * gateway — the cloud-home topology's `gateway pairing mint`, invoked
 * through the same exec API `cadet exec --service gateway` uses (the
 * platform runs it inside the gateway service's context). Process execution
 * is the local-presence proof. Returns the command's stdout; its last line
 * is the challenge JSON.
 */
export async function cloudPair(entry: LockfileAssistant): Promise<string> {
  const token = readCloudToken();
  if (!token) {
    throw new Error(
      "Not logged in. Run `cadet login` first to authenticate with Cadet Cloud.",
    );
  }
  const assistant = {
    assistantId: entry.assistantId,
    token,
    cloudUrl: getCloudUrl(),
  };
  const { output } = await execViaTerminalSession(
    assistant,
    ["bun", "run", "src/cli/index.ts", "pairing", "mint"],
    { timeoutMs: 30_000, service: "gateway" },
  );
  return output;
}
