/**
 * Tests for the loopback-guarded device endpoints: GET /v1/devices (list) and
 * POST /v1/devices/revoke (revoke by hashedDeviceId), scoped to the local
 * guardian principal.
 */
import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";

import { initSigningKey } from "../auth/token-service.js";
import { mintPairingPayload } from "../http/routes/pair.js";

initSigningKey(Buffer.from("test-signing-key-at-least-32-bytes-long-xx"));

// The pair guardian-lookup reads the gateway DB; the assistant DB proxy is
// mocked so any incidental assistant access stays inert in tests.
mock.module("../db/assistant-db-proxy.js", () => ({
  assistantDbQuery: mock(),
  assistantDbRun: mock(),
  assistantDbExec: mock(),
}));

const { initGatewayDb, resetGatewayDb, getGatewayDb } =
  await import("../db/connection.js");
const {
  actorTokenRecords,
  actorRefreshTokenRecords,
  contacts,
  contactChannels,
} = await import("../db/schema.js");
const {
  hashToken,
  mintAndRecordDeviceBoundTokenPair,
  mintAndRecordBrowserTokenPair,
  bootstrapGuardian,
} = await import("../auth/guardian-bootstrap.js");
const { verifyToken } = await import("../auth/token-service.js");
const { resolveScopeProfile } = await import("../auth/scopes.js");
const { MAX_PAIRING_USER_AGENT_CHARS } =
  await import("../auth/device-identity-text.js");
const { handleListDevices, handleRevokeDevice } =
  await import("../http/routes/devices.js");
const { resetPairRateLimiterForTests } = await import("../http/routes/pair.js");
const GUARDIAN_ID = "guardian-001";

let testRoot: string;

let actorSeedSeq = 0;

function seedActor(opts: {
  device: string;
  principal?: string;
  status?: "active" | "revoked";
  platform?: string;
  pairingUserAgent?: string;
  clientReportedName?: string;
  lastUsedAt?: number;
  updatedAt?: number;
}): void {
  const now = Date.now();
  const principal = opts.principal ?? GUARDIAN_ID;
  actorSeedSeq += 1;
  getGatewayDb()
    .insert(actorTokenRecords)
    .values({
      id: randomUUID(),
      tokenHash: hashToken(`acc-${principal}-${opts.device}-${actorSeedSeq}`),
      guardianPrincipalId: principal,
      hashedDeviceId: hashToken(opts.device),
      platform: opts.platform ?? "cli",
      pairingUserAgent: opts.pairingUserAgent,
      clientReportedName: opts.clientReportedName,
      status: opts.status ?? "active",
      issuedAt: now,
      expiresAt: now + 86_400_000,
      lastUsedAt: opts.lastUsedAt ?? null,
      createdAt: now,
      updatedAt: opts.updatedAt ?? now,
    })
    .run();
}

function seedRefresh(opts: {
  device: string;
  lastUsedAt?: number | null;
  status?: "active" | "revoked";
}): void {
  const now = Date.now();
  getGatewayDb()
    .insert(actorRefreshTokenRecords)
    .values({
      id: randomUUID(),
      tokenHash: hashToken(`ref-${opts.device}`),
      familyId: randomUUID(),
      guardianPrincipalId: GUARDIAN_ID,
      hashedDeviceId: hashToken(opts.device),
      platform: "cli",
      status: opts.status ?? "active",
      issuedAt: now,
      absoluteExpiresAt: now + 365 * 86_400_000,
      inactivityExpiresAt: now + 90 * 86_400_000,
      lastUsedAt: opts.lastUsedAt ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function activeActorCount(device: string): number {
  return getGatewayDb()
    .select()
    .from(actorTokenRecords)
    .where(
      and(
        eq(actorTokenRecords.hashedDeviceId, hashToken(device)),
        eq(actorTokenRecords.status, "active"),
      ),
    )
    .all().length;
}

function activeRefreshCount(device: string): number {
  return getGatewayDb()
    .select()
    .from(actorRefreshTokenRecords)
    .where(
      and(
        eq(actorRefreshTokenRecords.hashedDeviceId, hashToken(device)),
        eq(actorRefreshTokenRecords.status, "active"),
      ),
    )
    .all().length;
}

function actorRow(device: string) {
  return getGatewayDb()
    .select()
    .from(actorTokenRecords)
    .where(eq(actorTokenRecords.hashedDeviceId, hashToken(device)))
    .get();
}

function refreshRow(device: string) {
  return getGatewayDb()
    .select()
    .from(actorRefreshTokenRecords)
    .where(eq(actorRefreshTokenRecords.hashedDeviceId, hashToken(device)))
    .get();
}

beforeEach(async () => {
  resetPairRateLimiterForTests();
  testRoot = mkdtempSync(join(tmpdir(), "devices-test-"));
  const securityDir = join(testRoot, "protected");
  mkdirSync(securityDir, { recursive: true });
  process.env.GATEWAY_SECURITY_DIR = securityDir;
  await initGatewayDb();

  // resolveLocalGuardianPrincipalId() reads the gateway DB for the cadet
  // active guardian principal; seed one so device endpoints scope to it.
  const now = Date.now();
  getGatewayDb()
    .insert(contacts)
    .values({
      id: GUARDIAN_ID,
      displayName: "Guardian",
      role: "guardian",
      principalId: GUARDIAN_ID,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  getGatewayDb()
    .insert(contactChannels)
    .values({
      id: `ch-${GUARDIAN_ID}`,
      contactId: GUARDIAN_ID,
      type: "cadet",
      address: "guardian-cadet",
      isPrimary: false,
      status: "active",
      policy: "allow",
      interactionCount: 0,
      createdAt: now,
      updatedAt: now,
    })
    .run();
});

afterEach(() => {
  resetGatewayDb();
  delete process.env.GATEWAY_SECURITY_DIR;
  try {
    rmSync(testRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe("actorTokenRecords device identity columns", () => {
  test("round-trips pairingUserAgent and clientReportedName", () => {
    seedActor({
      device: "device-identity-populated",
      pairingUserAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      clientReportedName: "Alice's MacBook Pro",
    });

    const row = actorRow("device-identity-populated");
    expect(row?.pairingUserAgent).toBe(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    );
    expect(row?.clientReportedName).toBe("Alice's MacBook Pro");
  });

  test("leaves pairingUserAgent and clientReportedName null when omitted", () => {
    seedActor({ device: "device-identity-omitted" });

    const row = actorRow("device-identity-omitted");
    expect(row?.pairingUserAgent).toBeNull();
    expect(row?.clientReportedName).toBeNull();
  });
});

describe("minted token role", () => {
  test("a guardian mint records role guardian and carries actor_client_v1", () => {
    const pair = mintAndRecordDeviceBoundTokenPair({
      guardianPrincipalId: GUARDIAN_ID,
      deviceId: "mint-role-guardian",
      platform: "cli",
    });

    expect(actorRow("mint-role-guardian")?.role).toBe("guardian");
    expect(refreshRow("mint-role-guardian")?.role).toBe("guardian");

    const verified = verifyToken(pair.accessToken, "cadet-gateway");
    expect(verified.ok).toBe(true);
    expect(verified.ok && verified.claims.scope_profile).toBe(
      "actor_client_v1",
    );
  });

  test("a contact mint records role contact and carries contact_client_v1", () => {
    const pair = mintAndRecordDeviceBoundTokenPair({
      guardianPrincipalId: "contact-principal-1",
      deviceId: "mint-role-contact",
      platform: "web",
      role: "contact",
    });

    expect(actorRow("mint-role-contact")?.role).toBe("contact");
    expect(refreshRow("mint-role-contact")?.role).toBe("contact");

    const verified = verifyToken(pair.accessToken, "cadet-gateway");
    expect(verified.ok).toBe(true);
    expect(verified.ok && verified.claims.scope_profile).toBe(
      "contact_client_v1",
    );
  });

  test("a contact token grants no control-plane scope", () => {
    const scopes = resolveScopeProfile("contact_client_v1");
    for (const scope of [
      "admin.write",
      "settings.read",
      "settings.write",
      "feature_flags.write",
    ] as const) {
      expect(scopes.has(scope)).toBe(false);
    }
    expect(scopes.has("chat.write")).toBe(true);
  });

  test("a contact token grants no read scope", () => {
    // The routes behind these return the guardian's data to any holder, so
    // each one comes back only when its routes filter by caller.
    const scopes = resolveScopeProfile("contact_client_v1");
    for (const scope of [
      "chat.read",
      "approval.read",
      "attachments.read",
    ] as const) {
      expect(scopes.has(scope)).toBe(false);
    }
  });

  test("a browser mint carries the role through to both rows", () => {
    const pair = mintAndRecordBrowserTokenPair({
      guardianPrincipalId: "contact-principal-2",
      platform: "remote-web",
      browserRefreshCookiePath: "/v1/guardian/refresh",
      role: "contact",
    });

    const verified = verifyToken(pair.accessToken, "cadet-gateway");
    expect(verified.ok && verified.claims.scope_profile).toBe(
      "contact_client_v1",
    );
    const rows = getGatewayDb()
      .select()
      .from(actorTokenRecords)
      .where(eq(actorTokenRecords.guardianPrincipalId, "contact-principal-2"))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe("contact");
  });
});

describe("mintAndRecordDeviceBoundTokenPair identity persistence", () => {
  test("writes identity to both the actor-token row and the refresh-token row", () => {
    mintAndRecordDeviceBoundTokenPair({
      guardianPrincipalId: GUARDIAN_ID,
      deviceId: "mint-device-with-identity",
      platform: "cli",
      identity: {
        pairingUserAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
        clientReportedName: "Alice's MacBook Pro",
      },
    });

    const access = actorRow("mint-device-with-identity");
    expect(access?.pairingUserAgent).toBe(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    );
    expect(access?.clientReportedName).toBe("Alice's MacBook Pro");

    const refresh = refreshRow("mint-device-with-identity");
    expect(refresh?.pairingUserAgent).toBe(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    );
    expect(refresh?.clientReportedName).toBe("Alice's MacBook Pro");
  });

  test("writes null to both columns on both tables when identity is omitted", () => {
    mintAndRecordDeviceBoundTokenPair({
      guardianPrincipalId: GUARDIAN_ID,
      deviceId: "mint-device-without-identity",
      platform: "cli",
    });

    const access = actorRow("mint-device-without-identity");
    expect(access?.pairingUserAgent).toBeNull();
    expect(access?.clientReportedName).toBeNull();

    const refresh = refreshRow("mint-device-without-identity");
    expect(refresh?.pairingUserAgent).toBeNull();
    expect(refresh?.clientReportedName).toBeNull();
  });

  test("truncates an over-length User-Agent to MAX_PAIRING_USER_AGENT_CHARS", () => {
    const overLongUserAgent = "A".repeat(600);
    expect(overLongUserAgent.length).toBe(600);

    mintAndRecordDeviceBoundTokenPair({
      guardianPrincipalId: GUARDIAN_ID,
      deviceId: "mint-device-long-user-agent",
      platform: "cli",
      identity: { pairingUserAgent: overLongUserAgent },
    });

    const access = actorRow("mint-device-long-user-agent");
    expect(access?.pairingUserAgent?.length).toBe(MAX_PAIRING_USER_AGENT_CHARS);
    expect(access?.pairingUserAgent).toBe(
      "A".repeat(MAX_PAIRING_USER_AGENT_CHARS),
    );

    const refresh = refreshRow("mint-device-long-user-agent");
    expect(refresh?.pairingUserAgent?.length).toBe(
      MAX_PAIRING_USER_AGENT_CHARS,
    );
  });
});

describe("bootstrapGuardian host identity", () => {
  test("names the host credential after the machine hostname", async () => {
    await bootstrapGuardian({ platform: "cli", deviceId: "host-device" });

    const row = actorRow("host-device");
    expect(row?.clientReportedName).toBe(hostname());
    expect(row?.pairingUserAgent).toBeNull();

    // isCurrentHost (cli/src/commands/devices.ts) keys off hashedDeviceId; the
    // name must not disturb it.
    const devices = await handleListDevices();
    const listed = devices.find(
      (d) => d.hashedDeviceId === hashToken("host-device"),
    );
    expect(listed?.hashedDeviceId).toBe(hashToken("host-device"));
    expect(listed?.clientReportedName).toBe(hostname());
  });

  test("leaves clientReportedName null and still completes bootstrap when hostname() throws", async () => {
    const realOs = await import("node:os");
    mock.module("node:os", () => ({
      ...realOs,
      hostname: () => {
        throw new Error("no hostname available");
      },
    }));

    try {
      const result = await bootstrapGuardian({
        platform: "cli",
        deviceId: "host-device-throws",
      });
      expect(result.accessToken).toBeTruthy();
    } finally {
      mock.module("node:os", () => realOs);
    }

    const row = actorRow("host-device-throws");
    expect(row?.clientReportedName).toBeNull();
  });

  test("prefers a client-reported hostname over the gateway's own hostname", async () => {
    await bootstrapGuardian({
      platform: "cli",
      deviceId: "host-device-remote",
      clientReportedName: "Alices-MacBook-Pro.local",
    });

    const row = actorRow("host-device-remote");
    expect(row?.clientReportedName).toBe("Alices-MacBook-Pro.local");
  });
});

describe("/v1/pair clientReportedName", () => {
  test("persists a client-reported name on both minted rows (chrome-extension)", async () => {
    const res = await mintPairingPayload({
      deviceId: "device-ext-name",
      platform: "test",
      clientReportedName: "Alice's Chromebook",
    });
    expect(res.token).toBeTruthy();

    expect(actorRow("device-ext-name")?.clientReportedName).toBe(
      "Alice's Chromebook",
    );
    expect(refreshRow("device-ext-name")?.clientReportedName).toBe(
      "Alice's Chromebook",
    );
  });

  test("persists a client-reported name on both minted rows (cli)", async () => {
    const res = await mintPairingPayload({
      deviceId: "device-cli-name",
      platform: "test",
      clientReportedName: "Alice's MacBook Pro",
    });
    expect(res.token).toBeTruthy();

    expect(actorRow("device-cli-name")?.clientReportedName).toBe(
      "Alice's MacBook Pro",
    );
    expect(refreshRow("device-cli-name")?.clientReportedName).toBe(
      "Alice's MacBook Pro",
    );
  });

  test("records null when clientReportedName is omitted, and still pairs", async () => {
    const res = await mintPairingPayload({
      deviceId: "device-no-name",
      platform: "test",
    });
    expect(res.token).toBeTruthy();

    expect(actorRow("device-no-name")?.clientReportedName).toBeNull();
    expect(refreshRow("device-no-name")?.clientReportedName).toBeNull();
  });
});

describe("GET /v1/devices", () => {
  test("lists only the local principal's active devices", async () => {
    seedActor({ device: "device-A" });
    seedActor({ device: "device-B", platform: "webview" });
    seedActor({ device: "device-C", principal: "other-guardian" });
    seedActor({ device: "device-D", status: "revoked" });

    const devices = await handleListDevices();
    expect(devices.length).toBe(2);

    const ids = devices.map((d) => d.hashedDeviceId).sort();
    expect(ids).toEqual([hashToken("device-A"), hashToken("device-B")].sort());
    const a = devices.find((d) => d.hashedDeviceId === hashToken("device-A"));
    expect(a?.platform).toBe("cli");
  });

  test("surfaces pairingUserAgent and clientReportedName, alongside a correct lastUsedAt", async () => {
    seedActor({
      device: "device-A",
      pairingUserAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      clientReportedName: "Alice's MacBook Pro",
      lastUsedAt: 1_700_000_000_000,
    });
    seedActor({ device: "device-B" });

    const devices = await handleListDevices();

    const a = devices.find((d) => d.hashedDeviceId === hashToken("device-A"));
    expect(a?.pairingUserAgent).toBe(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    );
    expect(a?.clientReportedName).toBe("Alice's MacBook Pro");
    expect(a?.lastUsedAt).toBe(1_700_000_000_000);

    const b = devices.find((d) => d.hashedDeviceId === hashToken("device-B"));
    expect(b).toHaveProperty("pairingUserAgent", null);
    expect(b).toHaveProperty("clientReportedName", null);
  });

  test("surfaces lastUsedAt from the actor token row", async () => {
    seedActor({ device: "device-A", lastUsedAt: 1_700_000_000_000 });

    const devices = await handleListDevices();
    const a = devices.find((d) => d.hashedDeviceId === hashToken("device-A"));
    expect(a?.lastUsedAt).toBe(1_700_000_000_000);
  });

  test("serializes lastUsedAt as null when the token row is unstamped", async () => {
    seedActor({ device: "device-B" });
    // Guards against the refresh record's timestamp leaking into the response.
    seedRefresh({ device: "device-B", lastUsedAt: 1_700_000_000_000 });

    const devices = await handleListDevices();
    const b = devices.find((d) => d.hashedDeviceId === hashToken("device-B"));
    expect(b?.lastUsedAt).toBeNull();
  });

  test("keeps the stamp from a rotated-out row when the active row is unstamped", async () => {
    // Refreshing credentials revokes the stamped row and mints an unstamped
    // replacement; the device's activity history must survive that.
    seedActor({
      device: "device-A",
      status: "revoked",
      lastUsedAt: 1_700_000_000_000,
    });
    seedActor({ device: "device-A" });

    const devices = await handleListDevices();
    expect(devices).toHaveLength(1);
    expect(devices[0]?.lastUsedAt).toBe(1_700_000_000_000);
  });

  test("prefers the active row's stamp when it is newer than a rotated-out one", async () => {
    seedActor({
      device: "device-A",
      status: "revoked",
      lastUsedAt: 1_700_000_000_000,
    });
    seedActor({ device: "device-A", lastUsedAt: 1_800_000_000_000 });

    const devices = await handleListDevices();
    expect(devices[0]?.lastUsedAt).toBe(1_800_000_000_000);
  });

  test("returns null when no row for the device carries a stamp", async () => {
    seedActor({ device: "device-A", status: "revoked" });
    seedActor({ device: "device-A" });

    const devices = await handleListDevices();
    expect(devices[0]?.lastUsedAt).toBeNull();
  });

  test("does not borrow another principal's stamp for the same device hash", async () => {
    seedActor({
      device: "device-A",
      principal: "other-guardian",
      lastUsedAt: 1_700_000_000_000,
    });
    seedActor({ device: "device-A" });

    const devices = await handleListDevices();
    expect(devices).toHaveLength(1);
    expect(devices[0]?.lastUsedAt).toBeNull();
  });
});

describe("POST /v1/devices/revoke", () => {
  test("revokes a device's actor + refresh tokens, leaving others active", async () => {
    seedActor({ device: "device-A" });
    seedRefresh({ device: "device-A" });
    seedActor({ device: "device-B" });
    seedRefresh({ device: "device-B" });

    const res = await handleRevokeDevice(hashToken("device-A"));
    expect(res).toEqual({
      revoked: true,
      hashedDeviceId: hashToken("device-A"),
    });

    expect(activeActorCount("device-A")).toBe(0);
    expect(activeRefreshCount("device-A")).toBe(0);
    expect(activeActorCount("device-B")).toBe(1);
    expect(activeRefreshCount("device-B")).toBe(1);
  });

  test("clears the device's activity stamp so a re-pair starts fresh", async () => {
    // Device ids hash stably, so re-pairing reuses the same hashedDeviceId. The
    // list reads the max stamp across statuses, so an uncleared revoked row
    // would report a last use predating the new pairing.
    seedActor({ device: "device-A", lastUsedAt: 1_700_000_000_000 });
    seedRefresh({ device: "device-A" });

    await handleRevokeDevice(hashToken("device-A"));

    // Re-pair: a fresh, unstamped active row for the same device.
    seedActor({ device: "device-A" });

    const devices = await handleListDevices();
    expect(devices).toHaveLength(1);
    expect(devices[0]?.lastUsedAt).toBeNull();
  });

  test("clears the stamp on a rotated-out row so a re-pair starts fresh", async () => {
    // Any device older than one access-token TTL has rotated at least once,
    // which leaves a stamped revoked row behind. The list reads the max stamp
    // across statuses, so a revoke that only clears the active row would still
    // report the old activity after the re-pair.
    seedActor({
      device: "device-A",
      status: "revoked",
      lastUsedAt: 1_700_000_000_000,
    });
    seedActor({ device: "device-A", lastUsedAt: 1_800_000_000_000 });
    seedRefresh({ device: "device-A" });

    await handleRevokeDevice(hashToken("device-A"));

    // Re-pair: a fresh, unstamped active row for the same device.
    seedActor({ device: "device-A" });

    const devices = await handleListDevices();
    expect(devices).toHaveLength(1);
    expect(devices[0]?.lastUsedAt).toBeNull();
  });

  test("does not bump updatedAt on rows whose status is already revoked", async () => {
    // updatedAt tracks lifecycle, lastUsedAt tracks activity: clearing the
    // stamp on an already-revoked row must not read as a lifecycle change.
    seedActor({
      device: "device-A",
      status: "revoked",
      lastUsedAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    });
    seedActor({ device: "device-A" });

    await handleRevokeDevice(hashToken("device-A"));

    const rows = getGatewayDb()
      .select()
      .from(actorTokenRecords)
      .where(eq(actorTokenRecords.hashedDeviceId, hashToken("device-A")))
      .all();
    const untouched = rows.filter((r) => r.updatedAt === 1_700_000_000_000);
    expect(untouched).toHaveLength(1);
    expect(untouched[0]?.lastUsedAt).toBeNull();
  });

  test("leaves another device's stamp intact", async () => {
    seedActor({ device: "device-A", lastUsedAt: 1_700_000_000_000 });
    seedActor({ device: "device-B", lastUsedAt: 1_800_000_000_000 });

    await handleRevokeDevice(hashToken("device-A"));

    const devices = await handleListDevices();
    const b = devices.find((d) => d.hashedDeviceId === hashToken("device-B"));
    expect(b?.lastUsedAt).toBe(1_800_000_000_000);
  });
});
