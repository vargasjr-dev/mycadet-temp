import type { LockfileAssistant } from "../lockfile-contract";
import { pairDocker } from "../remotes/docker/pair";
import { pairLocal } from "../remotes/local/pair";

/**
 * The pair operation: obtain a device-bound credential from an assistant's
 * gateway. Like every operation it is a remote -> method router — the LEG
 * owns the transport that proves presence (host-loopback POST for local,
 * in-container exec for docker), and unsupported remotes refuse the same
 * way. The structured failure comes back for the caller to render; the
 * guardian lease and `cadet pair` are its consumers.
 */
export type PairOperationResult =
  | { ok: true; response: unknown }
  | { ok: false; status: number; error: string };

/** The device identity the gateway's pair route accepts. */
export interface PairDeviceIdentity {
  platform: string;
  deviceId: string;
  clientReportedName?: string;
}

export async function pairDevice(
  entry: LockfileAssistant,
  device: PairDeviceIdentity,
): Promise<PairOperationResult> {
  const body = JSON.stringify({
    platform: device.platform,
    deviceId: device.deviceId,
    ...(device.clientReportedName
      ? { clientReportedName: device.clientReportedName }
      : {}),
  });

  const result =
    entry.cloud === "docker"
      ? await pairDocker(entry.assistantId, body)
      : entry.cloud === "local"
        ? await pairLocal(entry, body)
        : {
            ok: false as const,
            status: 400,
            error: `pairing is unsupported for a ${entry.cloud} assistant.`,
          };
  if (!result.ok) {
    return {
      ok: false,
      status: result.status,
      error: `guardian pair failed (${result.status || "no response"}): ${result.error}`,
    };
  }
  return result;
}
