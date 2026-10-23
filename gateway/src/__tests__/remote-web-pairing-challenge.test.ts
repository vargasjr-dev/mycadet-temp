import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";

const { handleCreateRemoteWebPairingChallenge } =
  await import("../http/routes/remote-web-pairing-challenge.js");
const {
  approveRemoteWebPairingChallengeById,
  claimRemoteWebPairingChallengeExchange,
  completeRemoteWebPairingChallengeExchange,
  createRemoteWebPairingChallenge,
  denyRemoteWebPairingChallengeById,
  getRemoteWebPairingChallengeForTests,
  listPendingRemoteWebPairingChallenges,
  resetRemoteWebPairingChallengesForTests,
  setRemoteWebPairingChallengeNowForTests,
} = await import("../remote-web/pairing-challenge-store.js");
const { resetRemoteWebPairingChallengeRateLimiterForTests } =
  await import("../remote-web/pairing-challenge-rate-limit-store.js");
const { testSecurityDir, testWorkspaceDir } = await import("./test-preload.js");

import {
  LOOPBACK_IP,
  makePairingChallengeRequest as makeRequest,
  PUBLIC_BASE_URL,
  REMOTE_IP,
  TEST_REQUESTER,
} from "./helpers/remote-web-pairing-fixtures.js";

beforeEach(() => {
  resetRemoteWebPairingChallengesForTests();
  resetRemoteWebPairingChallengeRateLimiterForTests();
  // The loopback self-source reads this gateway's own workspace record;
  // each test seeds exactly what it needs.
  rmSync(join(testWorkspaceDir, "config.json"), { force: true });
});

/** Seed the workspace record the loopback self-source reads. */
function seedIngressPublicBaseUrl(url: string): void {
  writeFileSync(
    join(testWorkspaceDir, "config.json"),
    JSON.stringify({ ingress: { publicBaseUrl: url } }),
  );
}

describe("remote web pairing challenge", () => {
  test("creates an RFC-style short-lived challenge over direct loopback", async () => {
    setRemoteWebPairingChallengeNowForTests(() => 1_000);
    seedIngressPublicBaseUrl(PUBLIC_BASE_URL);

    const res = await handleCreateRemoteWebPairingChallenge(
      makeRequest(),
      LOOPBACK_IP,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");

    const body = (await res.json()) as {
      deviceCode: string;
      userCode: string;
      verificationUri: string;
      expiresAt: string;
      expiresInSeconds: number;
      intervalSeconds: number;
    };
    expect(body.deviceCode).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.userCode).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(body.verificationUri).toBe(`${PUBLIC_BASE_URL}/assistant/pair`);
    expect(body.expiresAt).toBe("1970-01-01T00:10:01.000Z");
    expect(body.expiresInSeconds).toBe(600);
    expect(body.intervalSeconds).toBe(5);
  });

  test("preserves path-prefixed public base URLs in the verification URI", async () => {
    seedIngressPublicBaseUrl("https://tunnel.example.test/assistant-123/");

    const res = await handleCreateRemoteWebPairingChallenge(
      makeRequest(),
      LOOPBACK_IP,
    );

    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      verificationUri: string;
      userCode: string;
    };
    expect(body.verificationUri).toBe(
      "https://tunnel.example.test/assistant-123/assistant/pair",
    );

    const record = getRemoteWebPairingChallengeForTests(body.userCode);
    expect(record?.publicBaseUrl).toBe(
      "https://tunnel.example.test/assistant-123",
    );
  });

  test("stores only hashed challenge secrets", async () => {
    seedIngressPublicBaseUrl(PUBLIC_BASE_URL);

    const res = await handleCreateRemoteWebPairingChallenge(
      makeRequest(),
      LOOPBACK_IP,
    );
    const body = (await res.json()) as {
      deviceCode: string;
      userCode: string;
    };

    const record = getRemoteWebPairingChallengeForTests(body.userCode);

    expect(record).toBeDefined();
    expect(record?.deviceCodeHash).not.toBe(body.deviceCode);
    expect(record?.userCodeHash).not.toBe(body.userCode);
    expect(record?.publicBaseUrl).toBe(PUBLIC_BASE_URL);
    expect(record?.status).toBe("pending");
  });

  test("creates a challenge through the nginx remote web edge", async () => {
    const res = await handleCreateRemoteWebPairingChallenge(
      makeRequest({
        edgeForwarded: true,
        host: "paired.example.com",
      }),
      REMOTE_IP,
      LOOPBACK_IP,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      verificationUri: string;
      userCode: string;
    };
    expect(body.verificationUri).toBe(`${PUBLIC_BASE_URL}/assistant/pair`);
    expect(getRemoteWebPairingChallengeForTests(body.userCode)).toBeDefined();
  });

  test("rejects direct non-loopback challenge creation without the edge marker", async () => {
    const res = await handleCreateRemoteWebPairingChallenge(
      makeRequest({ host: "paired.example.com" }),
      REMOTE_IP,
    );

    expect(res.status).toBe(403);
  });

  test("rejects spoofed edge marker from a non-loopback peer", async () => {
    const res = await handleCreateRemoteWebPairingChallenge(
      makeRequest({
        edgeForwarded: true,
        host: "paired.example.com",
      }),
      REMOTE_IP,
      REMOTE_IP,
    );

    expect(res.status).toBe(403);
  });

  test("rejects spoofed edge marker when X-Forwarded-For appears loopback", async () => {
    const res = await handleCreateRemoteWebPairingChallenge(
      makeRequest({
        edgeForwarded: true,
        host: "paired.example.com",
      }),
      LOOPBACK_IP,
      REMOTE_IP,
    );

    expect(res.status).toBe(403);
  });

  test("rate limits repeated challenge creation globally across rotated public hosts", async () => {
    for (let i = 0; i < 20; i++) {
      const host = `paired-${i}.example.com`;
      const res = await handleCreateRemoteWebPairingChallenge(
        makeRequest({
          edgeForwarded: true,
          host,
        }),
        LOOPBACK_IP,
      );
      expect(res.status).toBe(200);
    }

    const limited = await handleCreateRemoteWebPairingChallenge(
      makeRequest({
        edgeForwarded: true,
        host: "paired.example.com",
      }),
      LOOPBACK_IP,
    );

    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBeTruthy();
  });

  test("caps active challenge records even when rate limit state is reset", async () => {
    setRemoteWebPairingChallengeNowForTests(() => 1_000);
    seedIngressPublicBaseUrl(PUBLIC_BASE_URL);

    for (let i = 0; i < 200; i++) {
      resetRemoteWebPairingChallengeRateLimiterForTests();
      const res = await handleCreateRemoteWebPairingChallenge(
        makeRequest(),
        LOOPBACK_IP,
      );
      expect(res.status).toBe(200);
    }

    resetRemoteWebPairingChallengeRateLimiterForTests();
    const limited = await handleCreateRemoteWebPairingChallenge(
      makeRequest(),
      LOOPBACK_IP,
    );

    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("600");
    expect(await limited.json()).toEqual({
      error: {
        code: "PAIRING_CHALLENGE_CAPACITY_EXCEEDED",
        message: "too many pending remote web pairing challenges",
      },
    });
  });

  test("records requester metadata from the mint request", async () => {
    seedIngressPublicBaseUrl(PUBLIC_BASE_URL);

    const req = makeRequest();
    req.headers.set("user-agent", "PairBrowser/1.0");
    const res = await handleCreateRemoteWebPairingChallenge(req, LOOPBACK_IP);
    const body = (await res.json()) as { userCode: string };

    const record = getRemoteWebPairingChallengeForTests(body.userCode);
    expect(record?.requesterIp).toBe(LOOPBACK_IP);
    expect(record?.requesterUserAgent).toBe("PairBrowser/1.0");
    expect(record?.viaEdgeProxy).toBe(false);
    expect(record?.userCode).toBe(body.userCode);
    expect(record?.id).toBeTruthy();
  });

  test("records the edge-stamped client ip for tunneled mints", async () => {
    const res = await handleCreateRemoteWebPairingChallenge(
      makeRequest({
        edgeForwarded: true,
        edgeClientIp: REMOTE_IP,
        host: "paired.example.com",
      }),
      LOOPBACK_IP,
      LOOPBACK_IP,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { userCode: string };

    const record = getRemoteWebPairingChallengeForTests(body.userCode);
    expect(record?.requesterIp).toBe(REMOTE_IP);
    expect(record?.viaEdgeProxy).toBe(true);
  });

  test("falls back to the peer ip when the edge stamps no client ip", async () => {
    const res = await handleCreateRemoteWebPairingChallenge(
      makeRequest({ edgeForwarded: true, host: "paired.example.com" }),
      LOOPBACK_IP,
      LOOPBACK_IP,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { userCode: string };

    const record = getRemoteWebPairingChallengeForTests(body.userCode);
    expect(record?.requesterIp).toBe(LOOPBACK_IP);
    expect(record?.viaEdgeProxy).toBe(true);
  });

  test("ignores a forged client-ip header on direct loopback mints", async () => {
    seedIngressPublicBaseUrl(PUBLIC_BASE_URL);

    const res = await handleCreateRemoteWebPairingChallenge(
      makeRequest({ edgeClientIp: "198.51.100.99" }),
      LOOPBACK_IP,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { userCode: string };

    const record = getRemoteWebPairingChallengeForTests(body.userCode);
    expect(record?.requesterIp).toBe(LOOPBACK_IP);
    expect(record?.viaEdgeProxy).toBe(false);
  });

  test("self-sources the recorded ingress url on a direct loopback mint", async () => {
    seedIngressPublicBaseUrl("https://saved.example.test");

    const res = await handleCreateRemoteWebPairingChallenge(
      makeRequest(),
      LOOPBACK_IP,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      verificationUri: string;
      publicBaseUrl: string;
    };
    expect(body.verificationUri).toBe(
      "https://saved.example.test/assistant/pair",
    );
    expect(body.publicBaseUrl).toBe("https://saved.example.test");
  });

  test("self-sources the request host on an edge-proxied mint", async () => {
    const res = await handleCreateRemoteWebPairingChallenge(
      makeRequest({
        edgeForwarded: true,
        host: "paired.example.com",
        body: JSON.stringify({}),
      }),
      REMOTE_IP,
      LOOPBACK_IP,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { verificationUri: string };
    expect(body.verificationUri).toBe(
      "https://paired.example.com/assistant/pair",
    );
  });

  test("refuses a self-sourced loopback mint when no ingress url is recorded", async () => {
    const res = await handleCreateRemoteWebPairingChallenge(
      makeRequest({ body: JSON.stringify({}) }),
      LOOPBACK_IP,
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: {
        code: "BAD_REQUEST",
        message:
          "no public URL is recorded for this gateway — run `cadet tunnel start` first",
      },
    });
  });

  test("rejects oversized challenge request bodies", async () => {
    const body = JSON.stringify({ padding: "A".repeat(1024) });
    const res = await handleCreateRemoteWebPairingChallenge(
      makeRequest({
        edgeForwarded: true,
        host: "paired.example.com",
        body,
        contentLength: body.length,
      }),
      LOOPBACK_IP,
    );

    expect(res.status).toBe(413);
  });
});

describe("remote web pairing request list/approve/deny", () => {
  test("lists only pending, non-expired challenges newest first with requester metadata", () => {
    let now = 1_000;
    setRemoteWebPairingChallengeNowForTests(() => now);

    const first = createRemoteWebPairingChallenge(
      PUBLIC_BASE_URL,
      TEST_REQUESTER,
    );
    now = 2_000;
    const second = createRemoteWebPairingChallenge(PUBLIC_BASE_URL, {
      ip: "198.51.100.7",
      userAgent: null,
      viaEdgeProxy: false,
    });
    now = 3_000;
    const approved = createRemoteWebPairingChallenge(
      PUBLIC_BASE_URL,
      TEST_REQUESTER,
    );
    const approvedRecord = getRemoteWebPairingChallengeForTests(
      approved.userCode,
    );
    expect(
      approveRemoteWebPairingChallengeById(approvedRecord!.id).status,
    ).toBe("approved");

    const requests = listPendingRemoteWebPairingChallenges();

    expect(requests.map((r) => r.userCode)).toEqual([
      second.userCode,
      first.userCode,
    ]);
    expect(requests[0]).toEqual({
      requestId: getRemoteWebPairingChallengeForTests(second.userCode)!.id,
      userCode: second.userCode,
      publicBaseUrl: PUBLIC_BASE_URL,
      requestedAt: new Date(2_000).toISOString(),
      expiresAt: new Date(2_000 + 600_000).toISOString(),
      requesterIp: "198.51.100.7",
      requesterUserAgent: null,
      viaEdgeProxy: false,
    });
    expect(requests[1]?.requesterIp).toBe(REMOTE_IP);
    expect(requests[1]?.requesterUserAgent).toBe("PairBrowser/1.0");
    expect(requests[1]?.viaEdgeProxy).toBe(true);

    now = 1_000 + 600_000;
    expect(
      listPendingRemoteWebPairingChallenges().map((r) => r.userCode),
    ).toEqual([second.userCode]);
  });

  test("approve-by-id transitions pending to approved and the exchange succeeds", () => {
    setRemoteWebPairingChallengeNowForTests(() => 1_000);
    const challenge = createRemoteWebPairingChallenge(
      PUBLIC_BASE_URL,
      TEST_REQUESTER,
    );
    const record = getRemoteWebPairingChallengeForTests(challenge.userCode);

    const result = approveRemoteWebPairingChallengeById(record!.id);

    expect(result).toEqual({
      status: "approved",
      verificationUri: `${PUBLIC_BASE_URL}/assistant/pair`,
      expiresAt: new Date(1_000 + 600_000).toISOString(),
    });
    expect(
      claimRemoteWebPairingChallengeExchange(challenge.deviceCode).status,
    ).toBe("approved");
  });

  test("approve-by-id returns invalid for unknown ids", () => {
    expect(approveRemoteWebPairingChallengeById("missing-id")).toEqual({
      status: "invalid",
    });
  });

  test("approve-by-id on an expired challenge returns expired and evicts it", () => {
    let now = 1_000;
    setRemoteWebPairingChallengeNowForTests(() => now);
    const challenge = createRemoteWebPairingChallenge(
      PUBLIC_BASE_URL,
      TEST_REQUESTER,
    );
    const record = getRemoteWebPairingChallengeForTests(challenge.userCode);

    now = 1_000 + 600_000;
    expect(approveRemoteWebPairingChallengeById(record!.id)).toEqual({
      status: "expired",
    });
    expect(
      getRemoteWebPairingChallengeForTests(challenge.userCode),
    ).toBeUndefined();
    expect(
      claimRemoteWebPairingChallengeExchange(challenge.deviceCode).status,
    ).toBe("invalid");
  });

  test("approve-by-id on exchanging and consumed challenges returns invalid", () => {
    setRemoteWebPairingChallengeNowForTests(() => 1_000);
    const challenge = createRemoteWebPairingChallenge(
      PUBLIC_BASE_URL,
      TEST_REQUESTER,
    );
    const record = getRemoteWebPairingChallengeForTests(challenge.userCode);

    expect(approveRemoteWebPairingChallengeById(record!.id).status).toBe(
      "approved",
    );
    expect(
      claimRemoteWebPairingChallengeExchange(challenge.deviceCode).status,
    ).toBe("approved");
    expect(approveRemoteWebPairingChallengeById(record!.id)).toEqual({
      status: "invalid",
    });

    completeRemoteWebPairingChallengeExchange(challenge.deviceCode);
    expect(approveRemoteWebPairingChallengeById(record!.id)).toEqual({
      status: "invalid",
    });
  });

  test("deny removes the challenge from both lookup maps", () => {
    setRemoteWebPairingChallengeNowForTests(() => 1_000);
    const challenge = createRemoteWebPairingChallenge(
      PUBLIC_BASE_URL,
      TEST_REQUESTER,
    );
    const record = getRemoteWebPairingChallengeForTests(challenge.userCode);

    expect(denyRemoteWebPairingChallengeById(record!.id)).toEqual({
      status: "denied",
    });
    expect(
      getRemoteWebPairingChallengeForTests(challenge.userCode),
    ).toBeUndefined();
    expect(
      claimRemoteWebPairingChallengeExchange(challenge.deviceCode).status,
    ).toBe("invalid");
    expect(listPendingRemoteWebPairingChallenges()).toEqual([]);
  });

  test("deny of an approved challenge reports already_approved and keeps it", () => {
    setRemoteWebPairingChallengeNowForTests(() => 1_000);
    const challenge = createRemoteWebPairingChallenge(
      PUBLIC_BASE_URL,
      TEST_REQUESTER,
    );
    const record = getRemoteWebPairingChallengeForTests(challenge.userCode);
    expect(approveRemoteWebPairingChallengeById(record!.id).status).toBe(
      "approved",
    );

    expect(denyRemoteWebPairingChallengeById(record!.id)).toEqual({
      status: "already_approved",
    });
    expect(
      claimRemoteWebPairingChallengeExchange(challenge.deviceCode).status,
    ).toBe("approved");
  });

  test("deny of exchanging and consumed challenges reports already_approved", () => {
    setRemoteWebPairingChallengeNowForTests(() => 1_000);
    const challenge = createRemoteWebPairingChallenge(
      PUBLIC_BASE_URL,
      TEST_REQUESTER,
    );
    const record = getRemoteWebPairingChallengeForTests(challenge.userCode);
    expect(approveRemoteWebPairingChallengeById(record!.id).status).toBe(
      "approved",
    );
    expect(
      claimRemoteWebPairingChallengeExchange(challenge.deviceCode).status,
    ).toBe("approved");
    expect(denyRemoteWebPairingChallengeById(record!.id)).toEqual({
      status: "already_approved",
    });

    completeRemoteWebPairingChallengeExchange(challenge.deviceCode);
    expect(denyRemoteWebPairingChallengeById(record!.id)).toEqual({
      status: "already_approved",
    });
  });

  test("deny of an unknown id returns invalid", () => {
    expect(denyRemoteWebPairingChallengeById("missing-id")).toEqual({
      status: "invalid",
    });
  });
});

describe("file-backed persistence", () => {
  test("persists challenges to the security dir for other processes", () => {
    setRemoteWebPairingChallengeNowForTests(() => 1_000);
    createRemoteWebPairingChallenge(PUBLIC_BASE_URL, TEST_REQUESTER);

    const storePath = join(
      testSecurityDir,
      "remote-web-pairing-challenges.json",
    );
    expect(existsSync(storePath)).toBe(true);
    const persisted: unknown[] = JSON.parse(readFileSync(storePath, "utf-8"));
    expect(persisted).toHaveLength(1);

    // The reset helper removes the file so other tests start empty.
    resetRemoteWebPairingChallengesForTests();
    expect(existsSync(storePath)).toBe(false);
  });

  test("starts empty and warns when the store file is corrupt", () => {
    const storePath = join(
      testSecurityDir,
      "remote-web-pairing-challenges.json",
    );
    writeFileSync(storePath, "{not json", "utf-8");

    const challenge = createRemoteWebPairingChallenge(
      PUBLIC_BASE_URL,
      TEST_REQUESTER,
    );
    const stored = getRemoteWebPairingChallengeForTests(challenge.userCode);
    expect(stored).toBeDefined();
  });
});
