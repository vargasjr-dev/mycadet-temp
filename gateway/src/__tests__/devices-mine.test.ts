/**
 * Tests for GET /v1/devices/mine — the caller's own paired-device row. The
 * bearer IS the credential (browser-reachable by design), and the response
 * mirrors the /v1/devices projection for the caller's device so a
 * `devices/mine` answer matches that device's row in the host-side
 * `cadet devices` list field for field — including the cross-status
 * max(lastUsedAt) that keeps activity history across token rotation.
 */
import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

import { initSigningKey } from "../auth/token-service.js";

initSigningKey(Buffer.from("test-signing-key-at-least-32-bytes-long-xx"));

// The pair guardian-lookup reads the gateway DB; the assistant DB proxy is
// mocked so any incidental assistant access stays inert in tests.
mock.module("../db/assistant-db-proxy.js", () => ({
  assistantDbQuery: mock(),
  assistantDbRun: mock(),
  assistantDbExec: mock(),
}));

const { initGatewayDb, resetGatewayDb, getGatewayDb } = await import(
  "../db/connection.js"
);
const { actorTokenRecords, contacts, contactChannels } = await import(
  "../db/schema.js"
);
const { hashToken, mintAndRecordBrowserTokenPair } = await import(
  "../auth/guardian-bootstrap.js"
);
const { handleGetMyDevice } = await import("../http/routes/devices-mine.js");

const GUARDIAN_ID = "guardian-001";

let testRoot: string;

function mineRequest(bearer: string | null): Request {
  const headers = new Headers({ host: "localhost:7830" });
  if (bearer) {
    headers.set("authorization", `Bearer ${bearer}`);
  }
  return new Request("http://localhost:7830/v1/devices/mine", {
    method: "GET",
    headers,
  });
}

function rowForToken(token: string) {
  return getGatewayDb()
    .select()
    .from(actorTokenRecords)
    .where(eq(actorTokenRecords.tokenHash, hashToken(token)))
    .get();
}

beforeEach(async () => {
  testRoot = mkdtempSync(join(tmpdir(), "devices-mine-test-"));
  const securityDir = join(testRoot, "protected");
  mkdirSync(securityDir, { recursive: true });
  process.env.GATEWAY_SECURITY_DIR = securityDir;
  await initGatewayDb();

  // The route answers for any actor-token row; the guardian contact seed
  // mirrors the devices.test.ts fixture shape.
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
      createdAt: now,
      updatedAt: now,
    })
    .run();
});

afterEach(() => {
  resetGatewayDb();
  delete process.env.GATEWAY_SECURITY_DIR;
  rmSync(testRoot, { recursive: true, force: true });
});

describe("GET /v1/devices/mine", () => {
  test("returns the caller's own device row", async () => {
    const pair = mintAndRecordBrowserTokenPair({
      guardianPrincipalId: GUARDIAN_ID,
      platform: "web",
      browserRefreshCookiePath: "/",
      identity: { pairingUserAgent: "Mozilla/5.0 TestBrowser" },
    });

    const response = await handleGetMyDevice(mineRequest(pair.accessToken));
    expect(response.status).toBe(200);

    const body = (await response.json()) as { device: Record<string, unknown> };
    const stored = rowForToken(pair.accessToken);
    expect(stored).toBeTruthy();
    expect(body.device.hashedDeviceId).toBe(stored!.hashedDeviceId);
    expect(body.device.platform).toBe("web");
    expect(body.device.pairingUserAgent).toBe("Mozilla/5.0 TestBrowser");
    expect(body.device.issuedAt).toBe(stored!.issuedAt);
  });

  test("lastUsedAt is the cross-status max for the device", async () => {
    const pair = mintAndRecordBrowserTokenPair({
      guardianPrincipalId: GUARDIAN_ID,
      platform: "web",
      browserRefreshCookiePath: "/",
    });
    const stored = rowForToken(pair.accessToken);
    expect(stored).toBeTruthy();

    // A rotation revokes the old row and mints an unstamped replacement,
    // so the newest activity stamp can live on the revoked row — the same
    // rule the /v1/devices list applies.
    const now = Date.now();
    getGatewayDb()
      .insert(actorTokenRecords)
      .values({
        id: randomUUID(),
        tokenHash: hashToken(`rotated-${stored!.hashedDeviceId}`),
        guardianPrincipalId: GUARDIAN_ID,
        hashedDeviceId: stored!.hashedDeviceId,
        platform: "web",
        status: "revoked",
        issuedAt: now - 86_400_000,
        expiresAt: now + 86_400_000,
        lastUsedAt: now - 60_000,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const response = await handleGetMyDevice(mineRequest(pair.accessToken));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { device: { lastUsedAt: number | null } };
    expect(body.device.lastUsedAt).toBe(now - 60_000);
  });

  test("an unknown bearer answers 404, not an error", async () => {
    const response = await handleGetMyDevice(
      mineRequest("not-a-token-anyone-minted"),
    );
    expect(response.status).toBe(404);
  });

  test("a missing bearer answers 401", async () => {
    const response = await handleGetMyDevice(mineRequest(null));
    expect(response.status).toBe(401);
  });

  test("non-GET answers method not allowed", async () => {
    const response = await handleGetMyDevice(
      new Request("http://localhost:7830/v1/devices/mine", { method: "POST" }),
    );
    expect(response.status).toBe(405);
  });
});
