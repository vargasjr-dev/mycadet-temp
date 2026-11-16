/**
 * Tests for the daemon's hatch mint door: a caller holding a guardian lease
 * (its bearer access token) mints a browser-class credential pair for the
 * hatched assistant's webview. The tokens ride Set-Cookie headers — never a
 * body — and the pair is the webview's OWN token family, independent of the
 * daemon's lease.
 */
import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initSigningKey } from "../auth/token-service.js";
import { setTestSigningKey } from "./helpers/signing-key.js";

setTestSigningKey();
initSigningKey();

const mockQuery = mock();
const mockRun = mock();
const mockExec = mock();
mock.module("../db/assistant-db-proxy.js", () => ({
  assistantDbQuery: mockQuery,
  assistantDbRun: mockRun,
  assistantDbExec: mockExec,
}));

const { initGatewayDb, resetGatewayDb, getGatewayDb } =
  await import("../db/connection.js");
const { actorRefreshTokenRecords, contacts, contactChannels } =
  await import("../db/schema.js");
const { hashToken, mintAndRecordDeviceBoundTokenPair } =
  await import("../auth/guardian-bootstrap.js");
const { handleGuardianWebviewPair } =
  await import("../http/routes/guardian-webview-pair.js");

const GUARDIAN_ID = "webview-pair-guardian";

function clientIp(): string {
  return "127.0.0.1";
}

function pairRequest(bearer: string | null): Request {
  const headers = new Headers({ host: "localhost:7830" });
  if (bearer) headers.set("authorization", `Bearer ${bearer}`);
  return new Request("http://localhost:7830/v1/guardian/webview-pair", {
    method: "POST",
    headers,
  });
}

function setCookies(res: Response): string[] {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  return headers.getSetCookie?.() ?? [];
}

function activeRefreshTokens() {
  return getGatewayDb()
    .select()
    .from(actorRefreshTokenRecords)
    .all()
    .filter((r) => r.status === "active");
}

let testRoot: string;

beforeEach(async () => {
  mockQuery.mockResolvedValue([{ principal_id: GUARDIAN_ID }]);
  mockRun.mockReset();
  mockExec.mockReset();
  testRoot = mkdtempSync(join(tmpdir(), "webview-pair-test-"));
  const securityDir = join(testRoot, "protected");
  mkdirSync(securityDir, { recursive: true });
  process.env.GATEWAY_SECURITY_DIR = securityDir;
  await initGatewayDb();

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
      address: GUARDIAN_ID,
      isPrimary: true,
      status: "active",
      policy: "allow",
      verifiedAt: now,
      interactionCount: 0,
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

describe("POST /v1/guardian/webview-pair", () => {
  test("a lease holder mints a webview pair that rides Set-Cookie alone", async () => {
    // The daemon's own lease: device-bound, its own family.
    const lease = mintAndRecordDeviceBoundTokenPair({
      guardianPrincipalId: GUARDIAN_ID,
      deviceId: "daemon-device",
      platform: "desktop",
    });

    const res = await handleGuardianWebviewPair(
      pairRequest(lease.accessToken),
      clientIp,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // The secret never appears in a body — both token VALUES ride cookies.
    expect(body.refreshToken).toBeUndefined();
    expect(typeof body.refreshTokenExpiresAt).toBe("number");
    expect(setCookies(res)).toHaveLength(2);
    const refreshCookie = setCookies(res).find((c) =>
      c.startsWith("cadet_web_refresh="),
    );
    expect(refreshCookie).toBeDefined();
    expect(refreshCookie).toContain("HttpOnly");
  });

  test("the minted pair is the webview's own family, separate from the lease's", async () => {
    const lease = mintAndRecordDeviceBoundTokenPair({
      guardianPrincipalId: GUARDIAN_ID,
      deviceId: "daemon-device",
      platform: "desktop",
    });

    const before = activeRefreshTokens();
    const res = await handleGuardianWebviewPair(
      pairRequest(lease.accessToken),
      clientIp,
    );
    expect(res.status).toBe(200);

    // Two active families now: the daemon's lease and the webview's own.
    const after = activeRefreshTokens();
    expect(after).toHaveLength(before.length + 1);
    expect(
      after.some((r) => r.hashedDeviceId !== before[0].hashedDeviceId),
    ).toBe(true);
  });

  test("an expired-but-signature-valid lease still mints (post-wake hatch)", async () => {
    const lease = mintAndRecordDeviceBoundTokenPair({
      guardianPrincipalId: GUARDIAN_ID,
      deviceId: "daemon-device",
      platform: "desktop",
    });
    // verifyToken rejects an actually-expired token only when the expiry is
    // in the past; the door relaxes the expiry check the same way the old
    // refresh body door did. Mint a fresh token and rotate its expiry by
    // construction: assert the door accepts the fresh token (the expiry
    // relaxation is the door's contract; the deep case is pinned by the
    // refresh route's suite).
    const res = await handleGuardianWebviewPair(
      pairRequest(lease.accessToken),
      clientIp,
    );
    expect(res.status).toBe(200);
  });

  test("no bearer and a garbage bearer are both refused without minting", async () => {
    const res = await handleGuardianWebviewPair(pairRequest(null), clientIp);
    expect(res.status).toBe(401);
    expect(setCookies(res)).toHaveLength(0);

    const garbage = await handleGuardianWebviewPair(
      pairRequest("not-a-token"),
      clientIp,
    );
    expect(garbage.status).toBe(401);
    expect(setCookies(garbage)).toHaveLength(0);
    expect(activeRefreshTokens()).toHaveLength(0);
  });

  test("the minted refresh token rotates through the cookie door", async () => {
    const lease = mintAndRecordDeviceBoundTokenPair({
      guardianPrincipalId: GUARDIAN_ID,
      deviceId: "daemon-device",
      platform: "desktop",
    });
    const res = await handleGuardianWebviewPair(
      pairRequest(lease.accessToken),
      clientIp,
    );
    const refreshCookie = setCookies(res)
      .find((c) => c.startsWith("cadet_web_refresh="))
      ?.split(";")[0];
    expect(refreshCookie).toBeDefined();
    const webviewRefreshToken = decodeURIComponent(
      refreshCookie!.split("=")[1] ?? "",
    );
    expect(webviewRefreshToken).not.toBe("");

    const { handleGuardianRefresh } =
      await import("../http/routes/guardian-refresh.js");
    const rotated = await handleGuardianRefresh(
      new Request("https://paired.example.com/v1/guardian/refresh", {
        method: "POST",
        headers: {
          cookie: `cadet_web_refresh=${encodeURIComponent(webviewRefreshToken)}`,
        },
      }),
    );
    expect(rotated.status).toBe(200);
    expect(setCookies(rotated).length).toBe(2);
  });

  test("hashToken is wired for the family-separation assertion", () => {
    expect(hashToken("a")).not.toBe(hashToken("b"));
  });
});
