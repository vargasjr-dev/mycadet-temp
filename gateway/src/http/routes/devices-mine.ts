import { and, eq, max } from "drizzle-orm";

import { actorTokenRecordHash } from "../../auth/actor-token-revocation.js";
import { getGatewayDb } from "../../db/connection.js";
import { actorTokenRecords } from "../../db/schema.js";
import { errorResponse } from "../loopback-guard.js";
import { isCloudAuthBypassActive } from "../middleware/auth.js";

/**
 * `GET /v1/devices/mine` — the caller's own paired-device row.
 *
 * Deliberately browser-reachable (no loopback guard, no origin rejection):
 * the bearer IS the credential, and the route answers only for the token
 * presenting it. This is how the paired web UI surfaces "this device" so
 * its row can be matched against the host-side `cadet devices` list — the
 * gateway stores nothing but the hashed device id, so the hash is the only
 * matchable identity either side can name. The projection mirrors
 * `/v1/devices` exactly (including the cross-status `max(lastUsedAt)`, since
 * a rotation leaves the newest activity stamp on the revoked row), so a
 * `devices/mine` response matches the same device's row in the list output
 * field for field.
 */
export async function handleGetMyDevice(req: Request): Promise<Response> {
  if (req.method !== "GET") {
    return new Response("method not allowed", {
      status: 405,
      headers: { Allow: "GET" },
    });
  }

  // Cloud-hosted assistants have no paired-device rows to name — the route
  // only answers for self-hosted gateways.
  if (isCloudAuthBypassActive()) {
    return errorResponse(
      "NOT_AVAILABLE_ON_CLOUD",
      "this assistant is cloud-hosted — it has no paired-device rows",
      404,
    );
  }

  const authorization = req.headers.get("authorization") ?? "";
  const bearer = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";

  const db = getGatewayDb();
  const row = db
    .select({
      guardianPrincipalId: actorTokenRecords.guardianPrincipalId,
      hashedDeviceId: actorTokenRecords.hashedDeviceId,
      platform: actorTokenRecords.platform,
      pairingUserAgent: actorTokenRecords.pairingUserAgent,
      clientReportedName: actorTokenRecords.clientReportedName,
      issuedAt: actorTokenRecords.issuedAt,
      expiresAt: actorTokenRecords.expiresAt,
    })
    .from(actorTokenRecords)
    .where(eq(actorTokenRecords.tokenHash, actorTokenRecordHash(bearer)))
    .get();

  if (!row) {
    return errorResponse(
      "DEVICE_NOT_FOUND",
      "no paired device row for this token",
      404,
    );
  }

  const lastUsed = db
    .select({ lastUsedAt: max(actorTokenRecords.lastUsedAt) })
    .from(actorTokenRecords)
    .where(
      and(
        eq(actorTokenRecords.hashedDeviceId, row.hashedDeviceId),
        eq(actorTokenRecords.guardianPrincipalId, row.guardianPrincipalId),
      ),
    )
    .get();

  return Response.json(
    {
      device: {
        hashedDeviceId: row.hashedDeviceId,
        platform: row.platform,
        pairingUserAgent: row.pairingUserAgent ?? null,
        clientReportedName: row.clientReportedName ?? null,
        issuedAt: row.issuedAt,
        expiresAt: row.expiresAt ?? null,
        lastUsedAt: lastUsed?.lastUsedAt ?? null,
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
