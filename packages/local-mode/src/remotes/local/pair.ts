import { execOutput } from "../../exec";
import type {
  PairDeviceIdentity,
  PairOperationResult,
} from "../../operations/pair";
import { pairCliStdoutToResult } from "../../operations/pair";
import { isLocalEntry, type LockfileAssistant } from "../../lockfile-contract";
import { gatewayCliInvocation } from "./common";

/**
 * Pair by running the gateway's OWN CLI on this host (local topology): the
 * `gateway pair` command mints in-process — process execution is the
 * local-presence proof, and the invocation resolves the same workspace and
 * gateway security dir as the locally spawned gateway server. No HTTP, no
 * loopback. Prints the pair payload as single-line JSON on stdout.
 */
export async function pairLocal(
  entry: LockfileAssistant,
  device: PairDeviceIdentity,
): Promise<PairOperationResult> {
  const invocation = gatewayCliInvocation(
    isLocalEntry(entry) ? entry : undefined,
  );
  try {
    const stdout = await execOutput(
      invocation.command,
      [
        ...invocation.args,
        "pair",
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
