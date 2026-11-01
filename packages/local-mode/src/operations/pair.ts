import type { LockfileAssistant } from "../lockfile-contract";
import { pairDocker } from "../remotes/docker/pair";
import { pairLocal } from "../remotes/local/pair";

/**
 * The pair operation: obtain a device-bound credential from an assistant's
 * gateway. Like every operation it is a remote -> method router — the LEG
 * owns the transport that proves presence (the gateway's own CLI run on the
 * host for local, docker exec for docker), and unsupported remotes refuse
 * the same way. The structured failure comes back for the caller to render;
 * the guardian lease is its consumer.
 */
export type PairOperationResult =
  | { ok: true; response: unknown }
  | { ok: false; status: number; error: string };

/** The device identity the gateway's pair door accepts. */
export interface PairDeviceIdentity {
  platform: string;
  deviceId: string;
  clientReportedName?: string;
}

/**
 * The gateway CLI prints the pair payload as single-line JSON; its last
 * stdout line is the answer (earlier lines may carry warnings).
 */
export function pairCliStdoutToResult(stdout: string): PairOperationResult {
  const lastLine = stdout.split("\n").filter(Boolean).pop() ?? "";
  try {
    return { ok: true, response: JSON.parse(lastLine) };
  } catch {
    return {
      ok: false,
      status: 0,
      error: "could not parse the gateway's pair output",
    };
  }
}

export async function pairDevice(
  entry: LockfileAssistant,
  device: PairDeviceIdentity,
): Promise<PairOperationResult> {
  let result: PairOperationResult;
  switch (entry.cloud) {
    case "local":
      result = await pairLocal(entry, device);
      break;
    case "docker":
      result = await pairDocker(entry, device);
      break;
    default:
      result = {
        ok: false,
        status: 400,
        error: `pairing is unsupported for a ${entry.cloud} assistant.`,
      };
      break;
  }

  if (!result.ok) {
    return {
      ok: false,
      status: result.status,
      error: `guardian pair failed (${result.status || "no response"}): ${result.error}`,
    };
  }
  return result;
}
