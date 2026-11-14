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
import { GuardianTokenData } from "../../guardian-contract.js";
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
 * Mint a pairing token for a device
 */
export async function mintPairingPayload(opts: {
  deviceId: string;
  platform: string;
  clientReportedName?: string;
}): Promise<GuardianTokenData> {
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
