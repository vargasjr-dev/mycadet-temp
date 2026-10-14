import { remoteGatewayApiPath } from "@/lib/auth/remote-gateway-session";
import { getSelfHostedActorToken } from "@/lib/self-hosted/connection";

/** Mirrors one `/v1/devices` row — the same shape `cadet devices` prints. */
export interface MyDeviceRecord {
  hashedDeviceId: string;
  platform: string;
  pairingUserAgent: string | null;
  clientReportedName: string | null;
  issuedAt: number | null;
  expiresAt: number | null;
  lastUsedAt: number | null;
}

/**
 * The gateway's paired-device record for THIS browser.
 *
 * The gateway stores nothing but the hashed device id, so `hashedDeviceId`
 * is the only identity both sides can name: it matches, value for value,
 * the `hashedDeviceId` column of the host-side `cadet devices` list. Null
 * when there is no paired gateway session (cloud assistants have no
 * gateway device rows) or the gateway cannot answer.
 */
export async function fetchMyDevice(
  signal?: AbortSignal,
): Promise<MyDeviceRecord | null> {
  const token = getSelfHostedActorToken();
  if (!token) {
    return null;
  }

  const response = await fetch(remoteGatewayApiPath("/v1/devices/mine"), {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });
  if (!response.ok) {
    return null;
  }
  const body = (await response.json().catch(() => null)) as unknown;
  const device = (body as { device?: unknown } | null)?.device;
  if (typeof device !== "object" || device === null) {
    return null;
  }
  const record = device as Partial<MyDeviceRecord>;
  if (typeof record.hashedDeviceId !== "string") {
    return null;
  }
  return {
    hashedDeviceId: record.hashedDeviceId,
    platform: typeof record.platform === "string" ? record.platform : "",
    pairingUserAgent:
      typeof record.pairingUserAgent === "string"
        ? record.pairingUserAgent
        : null,
    clientReportedName:
      typeof record.clientReportedName === "string"
        ? record.clientReportedName
        : null,
    issuedAt: typeof record.issuedAt === "number" ? record.issuedAt : null,
    expiresAt: typeof record.expiresAt === "number" ? record.expiresAt : null,
    lastUsedAt:
      typeof record.lastUsedAt === "number" ? record.lastUsedAt : null,
  };
}
