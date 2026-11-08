import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  mintDevicePairing,
  pairingConnectivityHint,
  PairDeviceError,
} from "./pair-device-client";
import {
  fetchLog,
  installFetch,
  jsonResponse,
  resetFetchLog,
  restoreFetch,
  TEST_GATEWAY_BASE as BASE,
} from "./pair-device-test-helpers";

async function capturePairDeviceError(
  promise: Promise<unknown>,
): Promise<PairDeviceError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(PairDeviceError);
    return err as PairDeviceError;
  }
  throw new Error("expected the promise to reject");
}

beforeEach(() => {
  resetFetchLog();
});

afterEach(() => {
  restoreFetch();
});

describe("mintDevicePairing", () => {
  const MINT_ARGS = { base: BASE };
  const CHALLENGE_URL = `${BASE}/pairing-challenge`;
  const VERIFICATION_URL = `${BASE}/pairing-verification`;

  function challengeResponse(): Response {
    return jsonResponse({
      userCode: "WXYZ-1234",
      deviceCode: "device-code-1",
      verificationUri: "https://foo.ts.net/assistant/pair",
      expiresAt: "2026-08-17T10:10:00.000Z",
    });
  }

  test("attaches the connectivity hint when the challenge mint is rejected", async () => {
    installFetch(() =>
      jsonResponse({ error: { message: "Mint refused." } }, 403),
    );

    const err = await capturePairDeviceError(mintDevicePairing(MINT_ARGS));
    expect(err.message).toBe("Mint refused.");
    expect(err.hint).toBe(pairingConnectivityHint());
    // The challenge never minted, so there is no orphan to clean up.
    expect(fetchLog.map((r) => r.url)).toEqual([CHALLENGE_URL]);
  });

  test("attaches the connectivity hint when the verification step is rejected", async () => {
    installFetch((url) =>
      url === CHALLENGE_URL
        ? challengeResponse()
        : jsonResponse({ error: { message: "Verification failed." } }, 400),
    );

    const err = await capturePairDeviceError(mintDevicePairing(MINT_ARGS));
    expect(err.message).toBe("Verification failed.");
    expect(err.hint).toBe(pairingConnectivityHint());
  });

  test("propagates the verification failure with no cleanup fetches", async () => {
    installFetch((url) =>
      url === CHALLENGE_URL
        ? challengeResponse()
        : jsonResponse({ error: { message: "Verification failed." } }, 400),
    );

    const err = await capturePairDeviceError(mintDevicePairing(MINT_ARGS));

    // The original mint error propagates unchanged; the orphaned challenge
    // just TTLs out of the store.
    expect(err.message).toBe("Verification failed.");
    expect(err.hint).toBe(pairingConnectivityHint());
    expect(fetchLog.map((r) => r.url)).toEqual([
      CHALLENGE_URL,
      VERIFICATION_URL,
    ]);
  });

  test("rethrows the caller's abort during verification", async () => {
    installFetch((url) => {
      switch (url) {
        case CHALLENGE_URL:
          return challengeResponse();
        case VERIFICATION_URL:
          throw new DOMException("Aborted", "AbortError");
        default:
          throw new Error(`unexpected fetch: ${url}`);
      }
    });
    const controller = new AbortController();

    await expect(
      mintDevicePairing({ ...MINT_ARGS, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(fetchLog.map((r) => r.url)).toEqual([
      CHALLENGE_URL,
      VERIFICATION_URL,
    ]);
  });
});
