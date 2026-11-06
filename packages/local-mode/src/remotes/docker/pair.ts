import { execOutput } from "../../exec";
import {
  pairCliStdoutToResult,
  type PairDeviceIdentity,
  type PairOperationResult,
} from "../../operations/pair";
import type { LockfileAssistant } from "../../lockfile-contract";
import { dockerResourceNames } from "./retire";

/**
 * Pair by running the gateway's OWN CLI inside the container (docker
 * topology): the `gateway pairing mint` command, docker-exec'd from the
 * container's WORKDIR — the exec is the local-presence proof. `bun run
 * gateway` resolves the gateway package's own bin (node_modules/.bin).
 *
 * With a device identity the mint carries the --device-id flags and the
 * result parses to the pair payload (single-line JSON, persisted by the
 * caller). Without one it is the bare remote-web challenge mint the
 * `cadet pair` command wraps — the command's raw stdout, whose last line
 * is the challenge JSON.
 */
export function pairDocker(entry: LockfileAssistant): Promise<string>;
export function pairDocker(
  entry: LockfileAssistant,
  device: PairDeviceIdentity,
): Promise<PairOperationResult>;
export async function pairDocker(
  entry: LockfileAssistant,
  device?: PairDeviceIdentity,
): Promise<string | PairOperationResult> {
  const container = dockerResourceNames(entry.assistantId).gatewayContainer;
  const args = ["exec", container, "bun", "run", "gateway", "pairing", "mint"];
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
    const stdout = await execOutput("docker", args, {
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
