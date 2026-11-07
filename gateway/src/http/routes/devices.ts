/**
 * Device Management
 */

import { and, eq, max } from "drizzle-orm";

import {
  revokeActorTokensByDevice,
  revokeRefreshTokensByDevice,
} from "../../auth/guardian-bootstrap.js";
import { getGatewayDb } from "../../db/connection.js";
import { actorTokenRecords } from "../../db/schema.js";
import { resolveLocalGuardianPrincipalId } from "./pair.js";

export async function handleListDevices() {
  const guardianPrincipalId = await resolveLocalGuardianPrincipalId();
  const db = getGatewayDb();

  // One active actor token per (principal, device) via the unique index, so
  // this already enumerates distinct devices.
  const tokens = db
    .select({
      hashedDeviceId: actorTokenRecords.hashedDeviceId,
      platform: actorTokenRecords.platform,
      pairingUserAgent: actorTokenRecords.pairingUserAgent,
      clientReportedName: actorTokenRecords.clientReportedName,
      issuedAt: actorTokenRecords.issuedAt,
      expiresAt: actorTokenRecords.expiresAt,
    })
    .from(actorTokenRecords)
    .where(
      and(
        eq(actorTokenRecords.guardianPrincipalId, guardianPrincipalId),
        eq(actorTokenRecords.status, "active"),
      ),
    )
    .all();

  // Refreshing credentials revokes the active row and mints an unstamped
  // replacement, so the newest stamp for a device can live on a revoked row.
  // Take the max across every status to keep activity history across rotation.
  // Same principal filter as above with no status filter, so every listed
  // device is covered by a group here.
  const lastUsedRows = db
    .select({
      hashedDeviceId: actorTokenRecords.hashedDeviceId,
      lastUsedAt: max(actorTokenRecords.lastUsedAt),
    })
    .from(actorTokenRecords)
    .where(eq(actorTokenRecords.guardianPrincipalId, guardianPrincipalId))
    .groupBy(actorTokenRecords.hashedDeviceId)
    .all();

  const lastUsedByDevice = new Map<string, number | null>(
    lastUsedRows.map((r) => [r.hashedDeviceId, r.lastUsedAt ?? null]),
  );

  const devices = tokens.map((t) => ({
    hashedDeviceId: t.hashedDeviceId,
    platform: t.platform,
    pairingUserAgent: t.pairingUserAgent ?? null,
    clientReportedName: t.clientReportedName ?? null,
    issuedAt: t.issuedAt,
    expiresAt: t.expiresAt ?? null,
    lastUsedAt: lastUsedByDevice.get(t.hashedDeviceId) ?? null,
  }));

  return devices;
}

export async function handleRevokeDevice(id: string) {
  // Idempotent: revoking an unknown/already-revoked device is a no-op success.
  const guardianPrincipalId = await resolveLocalGuardianPrincipalId();
  revokeActorTokensByDevice(guardianPrincipalId, id);
  revokeRefreshTokensByDevice(guardianPrincipalId, id);

  return { revoked: true, hashedDeviceId: id };
}

export function devicesUsage(): string {
  return [
    "Usage: gateway devices <subcommand>",
    "",
    "Operator commands for gateway-owned device management",
    "",
    "Subcommands:",
    "  list                              List devices",
    "  revoke <contactId>                Revoke a device",
    "",
    "From the host: cadet exec --service gateway -- gateway devices list",
  ].join("\n");
}

export async function runDevicesCommand(args: string[]): Promise<number> {
  const method = args[0];
  const params = args.slice(1);
  if (!method || method === "--help" || method === "-h") {
    console.log(devicesUsage());
    return 0;
  }

  if (method === "list") {
    const devices = await handleListDevices();
    if (devices.length === 0) {
      console.log("No contacts found.");
      return 0;
    }
    for (const device of devices) {
      console.log(
        `${device.hashedDeviceId}  ${device.platform}  ${device.clientReportedName}`,
      );
    }
    console.log("");
    console.log(
      `${devices.length} ${devices.length === 1 ? "device" : "devices"}`,
    );
    return 0;
  }

  if (method === "revoke") {
    const deviceId = params[0];
    if (!deviceId) {
      console.error(`Device Id required to revoke.`);
      return 1;
    }
    const result = await handleRevokeDevice(deviceId);
    if (result.revoked) {
      console.log(`Device ${deviceId} revoked.`);
    } else {
      console.error(`Failed to revoke device ${deviceId}`);
    }
    return 0;
  }

  console.log(`Unexpected devices method: '${method}'`);
  return 0;
}
