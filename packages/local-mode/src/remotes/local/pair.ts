import { execOutput } from "../../exec";
import type {
  PairDeviceIdentity,
  PairOperationResult,
} from "../../operations/pair";
import { pairCliStdoutToResult } from "../../operations/pair";
import type { LocalAssistant } from "../../lockfile-contract";
import { gatewayCliInvocation } from "./common";

/**
 * Pair by running the gateway's OWN CLI on this host (local topology): the
 * `gateway pairing mint` command, invoked in-process — process execution is
 * the local-presence proof, and the invocation resolves the same workspace
 * and gateway security dir as the locally spawned gateway server. No HTTP,
 * no loopback.
 *
 * With a device identity the mint carries the --device-id flags and the
 * result parses to the pair payload (single-line JSON, persisted by the
 * caller). Without one it is the bare remote-web challenge mint the
 * `cadet pair` command wraps — the command's raw stdout, whose last line
 * is the challenge JSON.
 */
export function pairLocal(entry: LocalAssistant): Promise<string>;
export function pairLocal(
  entry: LocalAssistant,
  device: PairDeviceIdentity,
): Promise<PairOperationResult>;
export async function pairLocal(
  entry: LocalAssistant,
  device?: PairDeviceIdentity,
): Promise<string | PairOperationResult> {
  const invocation = gatewayCliInvocation(entry);
  const args = [...invocation.args, "pairing", "mint"];
  if (device) {
    args.push(
      "--platform",
      device.platform,
      "--device-id",
      device.deviceId,
      ...(device.clientReportedName
        ? ["--client-reported-name", device.clientReportedName]
        : []),
    );
  }
  try {
    const stdout = await execOutput(invocation.command, args, {
      cwd: invocation.cwd,
      env: invocation.env,
      timeoutMs: 30_000,
    });
    return device ? pairCliStdoutToResult(stdout) : stdout;
  } catch (err) {
    if (!device) throw err;
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
