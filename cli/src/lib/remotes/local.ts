import type { LocalAssistant } from "@mycadet/local-mode/contract";
import { gatewayCliInvocation } from "@mycadet/local-mode";
import { execOutput } from "../step-runner.js";

/**
 * Mint (and approve) a remote-web pairing challenge on the local gateway —
 * the `gateway pairing mint` the pair command wraps, run through the
 * gateway CLI invocation. Process execution is the local-presence proof.
 * Returns the command's stdout; its last line is the challenge JSON.
 */
export async function localPair(entry: LocalAssistant): Promise<string> {
  const invocation = gatewayCliInvocation(entry);
  return execOutput(
    invocation.command,
    [...invocation.args, "pairing", "mint"],
    {
      cwd: invocation.cwd,
      env: invocation.env,
      timeoutMs: 30_000,
    },
  );
}
