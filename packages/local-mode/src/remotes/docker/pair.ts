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
 * topology): the `gateway pairing mint --device-id` command mints the
 * device-bound credential in-process — the docker exec is the
 * local-presence proof, and no localhost fetch is fed through. `bun run
 * gateway` resolves the gateway package's own bin (node_modules/.bin), so
 * the CLI resolves exactly like the server's own run command from the
 * container's WORKDIR. Prints the pair payload as single-line JSON on
 * stdout.
 */
export async function pairDocker(
  entry: LockfileAssistant,
  device: PairDeviceIdentity,
): Promise<PairOperationResult> {
  const container = dockerResourceNames(entry.assistantId).gatewayContainer;
  try {
    const stdout = await execOutput(
      "docker",
      [
        "exec",
        container,
        "bun",
        "run",
        "gateway",
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
