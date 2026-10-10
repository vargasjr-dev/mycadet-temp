import type { GuardianTokenData } from "../../lib/guardian-token.js";

/**
 * A complete `GuardianTokenData` fixture with per-test overrides — the type's
 * nine fields are all required, so partial fakes need this to stand in.
 */
export function makeGuardianTokenData(
  over: Partial<GuardianTokenData> = {},
): GuardianTokenData {
  return {
    guardianPrincipalId: "principal-1",
    accessToken: "local-token",
    accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    refreshToken: "refresh-token",
    refreshTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    refreshAfter: new Date(Date.now() + 30_000).toISOString(),
    isNew: false,
    deviceId: "device-1",
    leasedAt: new Date().toISOString(),
    ...over,
  };
}
