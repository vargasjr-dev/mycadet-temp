import { execOutput } from "../../exec";
import type {
  PairDeviceIdentity,
  PairOperationResult,
} from "../../operations/pair";
import { pairCliStdoutToResult } from "../../operations/pair";
import type { LocalAssistant } from "../../lockfile-contract";
import { gatewayCliInvocation } from "./common";

/**
 * Mint a remote-web pairing challenge on the local gateway — the bare
 * `gateway pairing mint` the `cadet pair` command wraps, run through the
 * gateway CLI invocation. Process execution is the local-presence proof.
 * Returns the command's stdout; its last line is the challenge JSON.
 * The device-bound flow is {@link pairLocal}.
 */
export async function pairChallengeLocal(
  entry: LocalAssistant,
): Promise<string> {
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

/**
 * Pair by running the gateway's OWN CLI on this host (local topology): the
 * `gateway pairing mint --device-id` command mints the device-bound
 * credential in-process — process execution is the local-presence proof,
 * and the invocation resolves the same workspace and gateway security dir
 * as the locally spawned gateway server. No HTTP, no loopback. Prints the
 * pair payload as single-line JSON on stdout.
 */
export async function pairLocal(
  entry: LocalAssistant,
  device: PairDeviceIdentity,
): Promise<PairOperationResult> {
  const invocation = gatewayCliInvocation(entry);
  try {
    const stdout = await execOutput(
      invocation.command,
      [
        ...invocation.args,
        "pairing",
        "mint",
        "--platform",
        device.platform,
        "--device-id",
        device.deviceId,
        ...(device.clientReportedName
          ? ["--client-reported-name", device.clientReportedName]
          : []),
      ],
      {
        cwd: invocation.cwd,
        env: invocation.env,
        timeoutMs: 30_000,
      },
    );
    return pairCliStdoutToResult(stdout);
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
