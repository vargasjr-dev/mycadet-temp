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
