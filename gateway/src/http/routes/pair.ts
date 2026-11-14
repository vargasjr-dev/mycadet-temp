/**
 * Mint Pairing challenges
 */

import { and, eq } from "drizzle-orm";

import {
  mintAndRecordDeviceBoundTokenPair,
  resolveOrCreateCadetGuardian,
} from "../../auth/guardian-bootstrap.js";
import { getGatewayDb } from "../../db/connection.js";
import {
  contacts as gwContacts,
  contactChannels as gwContactChannels,
} from "../../db/schema.js";
import { getLogger } from "../../logger.js";

const log = getLogger("pair");

// ---------------------------------------------------------------------------
// Rate limiter (dedicated, per-peer)
// ---------------------------------------------------------------------------

interface RateLimitEntry {
  timestamps: number[];
}

const rateLimitMap = new Map<string, RateLimitEntry>();

/** Test helper: clear the rate limiter state. */
export function resetPairRateLimiterForTests(): void {
  rateLimitMap.clear();
}

// ---------------------------------------------------------------------------
// Guardian resolution
// ---------------------------------------------------------------------------

export async function resolveLocalGuardianPrincipalId(): Promise<string> {
  try {
    const row = getGatewayDb()
      .select({ principalId: gwContacts.principalId })
      .from(gwContacts)
      .innerJoin(
        gwContactChannels,
        eq(gwContactChannels.contactId, gwContacts.id),
      )
      .where(
        and(
          eq(gwContacts.role, "guardian"),
          eq(gwContactChannels.type, "cadet"),
          eq(gwContactChannels.status, "active"),
        ),
      )
      .limit(1)
      .get();
    if (row?.principalId) {
      return row.principalId;
    }
  } catch (err) {
    log.warn(
      { err },
      "Failed to look up local guardian principal; falling back to 'local'",
    );
  }
  return "local";
}

/**
 * The payload speaks the guardian token file's own field names so the
 * leasing side can parse it with that schema directly — no rename hop.
 */
export interface DeviceBoundPairPayload {
  accessToken: string;
  /** ISO-8601 instant the access token expires. */
  accessTokenExpiresAt: string;
  refreshToken: string;
  /** ISO-8601 instant the device-bound refresh token expires. */
  refreshTokenExpiresAt: string;
  /** ISO-8601 instant after which the client should refresh the session. */
  refreshAfter: string;
  guardianPrincipalId: string;
  /** The paired device's id, echoed so the lease can persist the binding. */
  deviceId: string;
  /** ISO-8601 instant the credential was leased. */
  leasedAt: string;
}

/**
 * Mint a pairing token for a device
 */
export async function mintPairingPayload(opts: {
  deviceId: string;
  platform: string;
  clientReportedName?: string;
}): Promise<DeviceBoundPairPayload> {
  const guardian = await resolveOrCreateCadetGuardian({
    allowMintWithEvidence: true,
  });
  const pair = mintAndRecordDeviceBoundTokenPair({
    guardianPrincipalId: guardian.guardianPrincipalId,
    deviceId: opts.deviceId,
    platform: opts.platform,
    identity: { clientReportedName: opts.clientReportedName },
  });

  return {
    accessToken: pair.accessToken,
    accessTokenExpiresAt: new Date(pair.accessTokenExpiresAt).toISOString(),
    refreshToken: pair.refreshToken,
    refreshTokenExpiresAt: new Date(pair.refreshTokenExpiresAt).toISOString(),
    refreshAfter: new Date(pair.refreshAfter).toISOString(),
    guardianPrincipalId: guardian.guardianPrincipalId,
    deviceId: opts.deviceId,
    leasedAt: new Date().toISOString(),
  };
}
