/**
 * Tests for the pairing mint IPC route: the surface `cadet pair` reaches
 * through `gateway pairing mint <url>` (directly, or docker-exec'd inside the
 * gateway container). Process execution is the presence proof, so the route
 * has no peer gate — what it must guarantee is the mint-and-approve sequence
 * against the same in-memory store the verification/token routes read.
 */

import { beforeEach, describe, expect, test } from "bun:test";

const { createPairingIpcRoutes, PAIRING_MINT_IPC_METHOD } =
  await import("../pairing-handlers.js");
const {
  claimRemoteWebPairingChallengeExchange,
  completeRemoteWebPairingChallengeExchange,
  getRemoteWebPairingChallengeForTests,
  resetRemoteWebPairingChallengesForTests,
} = await import("../../remote-web/pairing-challenge-store.js");
const { resetRemoteWebPairingChallengeRateLimiterForTests } =
  await import("../../remote-web/pairing-challenge-rate-limit-store.js");

const PUBLIC_BASE_URL = "https://my-assistant.ts.net";

let mint: (publicBaseUrl: string) => unknown;

beforeEach(() => {
  resetRemoteWebPairingChallengesForTests();
  resetRemoteWebPairingChallengeRateLimiterForTests();

  const route = createPairingIpcRoutes().find(
    (r) => r.method === PAIRING_MINT_IPC_METHOD,
  );
  if (!route) throw new Error("pairing mint route not registered");
  mint = (publicBaseUrl: string) => route.handler({ publicBaseUrl }) as unknown;
});

function mintErrorOf(publicBaseUrl: string): {
  statusCode?: number;
  code?: string;
  message: string;
} {
  try {
    mint(publicBaseUrl);
    throw new Error("expected the mint to throw");
  } catch (err) {
    if (err instanceof Error && err.message === "expected the mint to throw") {
      throw err;
    }
    const withCode = err as { statusCode?: number; code?: string };
    return {
      statusCode: withCode.statusCode,
      code: withCode.code,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

describe("pairing mint IPC route", () => {
  test("mints an approved challenge with the advertised URL baked into verificationUri", () => {
    const challenge = mint(PUBLIC_BASE_URL) as {
      deviceCode: string;
      userCode: string;
      verificationUri: string;
      expiresInSeconds: number;
      intervalSeconds: number;
    };

    expect(challenge.deviceCode).toBeTruthy();
    expect(challenge.userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(challenge.verificationUri).toBe(`${PUBLIC_BASE_URL}/assistant/pair`);
    expect(challenge.intervalSeconds).toBe(5);
    expect(challenge.expiresInSeconds).toBeGreaterThan(0);

    const stored = getRemoteWebPairingChallengeForTests(challenge.userCode);
    expect(stored?.status).toBe("approved");
  });

  test("the minted deviceCode is immediately exchangeable (approved, not pending)", () => {
    const challenge = mint(PUBLIC_BASE_URL) as { deviceCode: string };

    const claim = claimRemoteWebPairingChallengeExchange(challenge.deviceCode);
    if (claim.status !== "approved") {
      throw new Error(`expected approved claim, got ${claim.status}`);
    }
    expect(claim.publicBaseUrl).toBe(PUBLIC_BASE_URL);

    completeRemoteWebPairingChallengeExchange(challenge.deviceCode);
    const consumed = claimRemoteWebPairingChallengeExchange(
      challenge.deviceCode,
    );
    expect(consumed.status).toBe("consumed");
  });

  test("rejects URLs the HTTP route would reject, with a 400", () => {
    // Empty strings are rejected by the route schema (server-side); these
    // reach the handler's own parsePublicBaseUrl validation.
    for (const bad of ["not a url", "ftp://x.example.com"]) {
      const err = mintErrorOf(bad);
      expect(err.statusCode).toBe(400);
      expect(err.code).toBe("BAD_REQUEST");
    }
  });
});
